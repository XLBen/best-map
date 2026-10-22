import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SCRIPT_HELPERS, type ScriptKind, type ScriptVariable, scriptVariablesFor } from '../../core/script';
import { worldState } from '../state';
import { type ApplyMode, type ApplyResult, ScriptEdit, type ScriptProblem, problemCell, problemLine } from './script-commit';
import { SCRIPT_EXAMPLES } from './script-examples';
import { checkScript, loadAcorn } from './script-syntax';

// 脚本框：等宽字的文本框，左边有行号；下面一行红字说哪里不对（“第 3 行：没有变量 tMeen（是不是 tMean？）”）；
// “变量和例子…”列出能用的变量（中英文名都能用）、辅助函数和几段例子。
// 打字停 600 毫秒、检查通过后真的用到地图上（见 script-commit.ts）；在主线程上只用 acorn 解析，从不运行脚本

const GROUP_ORDER: ScriptVariable['group'][] = ['气候', '地形', '水', '位置', '改动', '颜色', '地形生成', '布局', '世界'];

interface Props {
  kind: ScriptKind;
  // 框上方的名字（“长在哪里”）和一句说明
  label: string;
  hint?: string;
  // 世界里现在的这段脚本（没有为 ''）
  value: string;
  // 世界上这段脚本现在出的错（每次都现取：提交之后要读到新的）
  issue: () => ScriptProblem | null;
  // 提交到世界上：exec 新的一步，replace 换掉这次编辑上一次提交的那一步
  apply: (src: string, mode: ApplyMode) => Promise<ApplyResult>;
  // 世界上有的自定义场（检查 field('名字')）
  fields?: readonly string[];
  // 主线程的语法、名字检查通过之后再加的验证（以后接上：在临时 worker 里用真实世界的数组先跑一遍、查纯度）
  validate?: (src: string) => Promise<ScriptProblem | null>;
  // 点“去看”：镜头移到这一格
  onShowCell?: (cell: number) => void;
  // 变了就把光标放进框里（别处的“编辑”）
  focusSignal?: number;
}

const lineCount = (s: string) => s.split(/\r\n|[\n\r\u2028\u2029]/).length;

export function ScriptBox(props: Props) {
  const { kind, label, hint, value } = props;
  const [, redraw] = useState(0);
  const [help, setHelp] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // 最新的 props（ScriptEdit 只建一次，提交时要用最新的 apply、issue、自定义场）
  const live = useRef(props);
  live.current = props;
  const edit = useMemo(
    () =>
      new ScriptEdit(
        {
          check: async (src) => (await checkScript(kind, src, live.current.fields)) ?? (src && live.current.validate ? await live.current.validate(src) : null),
          apply: (src, mode) => live.current.apply(src, mode),
          stateId: () => worldState.value,
          issue: () => live.current.issue(),
          onChange: () => redraw((x) => x + 1),
        },
        value,
        props.issue(),
      ),
    [],
  );
  // 打开时就加载 acorn（一小块代码）：第一次停顿时不用等它
  useEffect(() => void loadAcorn(), []);
  // 世界上的这段脚本、它的出错变了（撤销、重做、别的改动之后）
  const issueKey = JSON.stringify(props.issue());
  useEffect(() => edit.sync(value, props.issue()), [value, issueKey]);
  // 离开（关上抽屉、换了生态）时还没提交的也提交
  useEffect(() => () => void edit.flush(), []);
  useEffect(() => {
    if (props.focusSignal) {
      ref.current?.focus();
      boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [props.focusSignal]);
  // 变量和例子：点外面、按 Esc 关上（Esc 只关它，不关抽屉）
  useEffect(() => {
    if (!help) return;
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setHelp(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setHelp(false);
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [help]);

  const v = edit.view();
  const lines = lineCount(v.draft);
  const bad = v.problem && v.problem.reason !== 'disabled' ? v.problem.line : undefined;
  const cell = problemCell(v.problem);

  // 插入：变量名、缩进插在光标处；例子（whole）在框是空的时直接填进去，否则接在最后
  const insert = (text: string, whole = false) => {
    const ta = ref.current;
    const cur = v.draft;
    let next: string;
    let caret: number;
    if (whole || !ta) {
      next = cur.trim() ? `${cur.replace(/\s*$/, '')}\n${text}` : text;
      caret = next.length;
    } else {
      const a = ta.selectionStart;
      const b = ta.selectionEnd;
      next = cur.slice(0, a) + text + cur.slice(b);
      caret = a + text.length;
    }
    if (ta && document.activeElement !== ta) ta.focus();
    edit.input(next);
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret));
  };

  return (
    <div class="script-box" ref={boxRef}>
      <div class="row between script-head">
        <span>
          {label}
          {hint && <span class="muted small"> {hint}</span>}
        </span>
        <button class={`small ghost ${help ? 'on' : ''}`} onClick={() => setHelp(!help)}>
          变量和例子…
        </button>
      </div>
      <div class={`script-edit ${v.problem && v.problem.reason !== 'disabled' ? 'has-problem' : ''}`}>
        <div class="script-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, k) => (
            <div class={k + 1 === bad ? 'bad' : ''}>{k + 1}</div>
          ))}
        </div>
        <textarea
          ref={ref}
          value={v.draft}
          rows={Math.min(16, Math.max(4, lines + 1))}
          wrap="off"
          spellcheck={false}
          autocomplete="off"
          placeholder={kind === 'placement' ? '// 比如：return 海拔 > 1000;' : kind === 'color' ? '// 比如：return [200, 80, 60];' : '// 写 return …'}
          onFocus={() => edit.focus()}
          onBlur={() => void edit.blur()}
          onInput={(e) => edit.input((e.target as HTMLTextAreaElement).value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
          }}
          onKeyDown={(e) => {
            // Tab 缩进两格（不跳出框）
            if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              insert('  ');
            }
          }}
        />
      </div>
      {v.problem && (
        <div class={v.problem.reason === 'disabled' ? 'script-note muted small' : 'script-problem small'}>
          {problemLine(v.problem)}
          {cell !== undefined && (
            <>
              {v.problem.text.includes('地图上有一处') ? '' : '。地图上有一处是这样'}
              <span class="link" onClick={() => props.onShowCell?.(cell)}>
                （点这里去看）
              </span>
            </>
          )}
          {v.stale && <div class="muted">地图上还是上一次没出错的样子。</div>}
        </div>
      )}
      {help && <ScriptHelp kind={kind} onInsert={insert} />}
    </div>
  );
}

// 变量和例子（点名字插到光标处，点例子填进框里）
function ScriptHelp({ kind, onInsert }: { kind: ScriptKind; onInsert: (text: string, whole?: boolean) => void }) {
  const vars = scriptVariablesFor(kind);
  const groups = GROUP_ORDER.map((g) => [g, vars.filter((x) => x.group === g)] as const).filter(([, list]) => list.length);
  // 按钮不抢走框里的光标
  const keep = (e: Event) => e.preventDefault();
  return (
    <div class="script-help">
      <p class="muted small">
        脚本是一段小程序，最后写 <code>return …</code> 给出结果。变量用英文名、中文名都行。点名字插进光标处。
      </p>
      <h5>例子</h5>
      {SCRIPT_EXAMPLES[kind].map((ex) => (
        <div class="script-example">
          <pre>{ex.src}</pre>
          <button class="small" onMouseDown={keep} onClick={() => onInsert(ex.src, true)} title={ex.label}>
            用这个：{ex.label}
          </button>
        </div>
      ))}
      {groups.map(([g, list]) => (
        <>
          <h5>{g}</h5>
          {list.map((x) => (
            <div class="script-var">
              <code class="link" onMouseDown={keep} onClick={() => onInsert(x.zh ?? x.key)}>
                {x.zh ?? x.key}
              </code>
              {x.zh && (
                <code class="link muted" onMouseDown={keep} onClick={() => onInsert(x.key)}>
                  {x.key}
                </code>
              )}
              <span class="muted">
                {x.label}
                {x.unit ? `（${x.unit}）` : ''}
              </span>
            </div>
          ))}
        </>
      ))}
      <h5>辅助函数</h5>
      {SCRIPT_HELPERS.map((h) => (
        <div class="script-var">
          <code class="link" onMouseDown={keep} onClick={() => onInsert(h.name === 'Math' ? 'Math.' : `${h.name}(`)}>
            {h.usage}
          </code>
          <span class="muted">{h.label}</span>
        </div>
      ))}
    </div>
  );
}
