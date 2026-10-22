import { useEffect, useRef, useState } from 'preact/hooks';
import type { PlanetForm } from '../../core/planet-form';
import { type ScriptIssue, findScripts } from '../../core/script';
import { saveForm } from '../library';
import { formThumbnail, showToast } from '../state';
import { trustScripts } from '../trust';
import { type FormEditorState, closeFormEditor, formEditor } from './form-store';
import { FORM_BASES, FORM_KNOBS, type FormScriptKind, finalForm, formGen, formProblem, knobText, planetTypeName, withCrustMode, withScript } from './forms';
import { ScriptBox } from './ScriptBox';
import { type ScriptProblem, normScript, problemLine, problemOfIssue } from './script-commit';
import { checkScript } from './script-syntax';

// 星球形态编辑器：名字、一句话说明、从哪种星球改起、几个滑块（陆地多少、岛多少、板块数、大陆块数、大陆大小、山脉宽窄），
// 收起的“脚本”里是布局、地形两个脚本框。右边是实时的缩略图（停 0.5 秒再算，与新建时同一个生成器），下面一行写脚本出的错。
// 改的是内置的、导入的形态时改的是一份副本，原来的不变。按钮：取消 / 存进资源库（“我的资源”）/ 用它新建

const W = 240;
const H = 120;
const PAUSE_MS = 500;

interface Shot {
  // 按哪个形态、种子算的
  key: string;
  thumb?: Uint8ClampedArray;
  issues: ScriptIssue[];
  error?: string;
}

// 缩略图按什么算：名字、说明不算（改名字时不重算）
const looks = (f: PlanetForm) => {
  const { name: _n, hint: _h, ...rest } = f;
  return rest;
};
const keyOf = (form: PlanetForm, seed: number) => JSON.stringify([looks(form), seed]);
// 两段脚本（卡住被停下的是哪一份）
const scriptsOf = (form: PlanetForm) => JSON.stringify(form.scripts ?? null);
// 缩略图没算完就被停下了（脚本卡住、点了“停下”）：Worker 换了一个、世界从命令记录里恢复过。
// 同样的脚本再算还会这样（每次都要恢复一遍世界），改了脚本才再算
const HUNG = '脚本算得太久，被停下了：改一改脚本再看';
// 算缩略图时名字空着也照样算（名字不影响样子；空的名字在按钮那里拦下）
const named = (f: PlanetForm): PlanetForm => (f.name ? f : { ...f, name: '未命名' });
const KIND_LABEL: Record<FormScriptKind, string> = { setup: '布局', crust: '地形' };
const randomSeed = () => Math.floor(Math.random() * 1e6);

function Canvas({ data, stale }: { data: Uint8ClampedArray | undefined; stale: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
  }, [data]);
  return <canvas ref={ref} width={W} height={H} class={stale || !data ? 'stale' : ''} />;
}

function Editor({ st }: { st: FormEditorState }) {
  const [form, setFormState] = useState(st.initial);
  // 最新的形态（脚本框提交后马上要按它判断出错是不是这一段的，等不到重画）
  const formRef = useRef(st.initial);
  const setForm = (next: PlanetForm) => {
    formRef.current = next;
    setFormState(next);
  };
  const [seed, setSeed] = useState(st.seed);
  const seedRef = useRef(st.seed);
  seedRef.current = seed;
  const [shot, setShot] = useState<Shot | null>(null);
  const shotRef = useRef<Shot | null>(null);
  shotRef.current = shot;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // 被停下的那一份脚本（scriptsOf）：脚本不改就不再算缩略图，按钮也不能点
  const [hung, setHung] = useState<string | null>(null);
  const stuck = hung !== null && hung === scriptsOf(form);
  // 两个脚本框里现在写的（还没检查、提交的也算）：点按钮时用它
  const drafts = useRef<Partial<Record<FormScriptKind, string>>>({});
  const key = keyOf(form, seed);
  const problem = formProblem(form);
  // 挡着缩略图的问题（名字的问题不挡）
  const shapeProblem = formProblem(named(form));

  // 实时缩略图：形态、种子停 0.5 秒没变再算；算的期间又变了就不要这一张
  useEffect(() => {
    if (shapeProblem || stuck) return;
    let live = true;
    const scripts = scriptsOf(form);
    const t = setTimeout(() => {
      void formThumbnail(st.settings, formGen(seed, named(form)), W, H).then((r) => {
        // 被停下了：算的期间改过也记下（是这一份脚本卡住的）
        if ('error' in r && r.stopped) setHung(scripts);
        if (live) setShot('error' in r ? { key, issues: [], error: r.stopped ? HUNG : r.error } : { key, thumb: r.thumb, issues: r.issues });
      });
    }, PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, shapeProblem, stuck]);

  const current = shot?.key === key ? shot : null;
  // 画着的是上一张（还在算新的）时保留它，淡一点
  const shown = current ?? shot;
  const firstIssue = current?.issues.find((i) => i.reason !== 'disabled');
  const disabled = current?.issues.some((i) => i.reason === 'disabled');

  // 脚本框下面的出错：只认按现在的形态算出来的那一张缩略图（刚提交的一段还没算好时不拿上一段的错冒充）
  const issueOf = (kind: FormScriptKind): ScriptProblem | null => {
    const s = shotRef.current;
    if (!s || s.key !== keyOf(formRef.current, seedRef.current)) return null;
    const i = s.issues.find((x) => x.kind === kind);
    return i ? { ...problemOfIssue(i), cell: undefined } : null;
  };
  // 脚本框停一下、检查通过后：换进形态（缩略图跟着重算）
  const applyScript = (kind: FormScriptKind) => async (src: string) => {
    setForm(withScript(formRef.current, kind, src));
    return { ok: true as const };
  };

  // 点按钮时：框里刚写、还没用上的也算进去（检查不过就说哪里不对，不存也不新建）
  const final = async (): Promise<PlanetForm | null> => {
    let f = formRef.current;
    for (const kind of ['setup', 'crust'] as const) {
      const draft = drafts.current[kind];
      if (draft === undefined || normScript(draft) === normScript(f.scripts?.[kind]?.src ?? '')) continue;
      const p = normScript(draft) ? await checkScript(kind, draft) : null;
      if (p) {
        setMsg(`${KIND_LABEL[kind]}脚本：${problemLine(p)}`);
        return null;
      }
      f = withScript(f, kind, draft);
    }
    if (f !== formRef.current) setForm(f);
    return finalForm(f, st.original, st.mine, st.others);
  };
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const f = await final();
      if (!f) return;
      // 没改过：它本来就在资源库里，不再存一份一模一样的（列表里一模一样的只列一次，存了也看不到），选上它
      if (st.original && f === st.original && st.originalKey) {
        showToast(`没有改动：「${f.name}」本来就在资源库里`);
        closeFormEditor();
        st.onSaved(f, st.originalKey);
        return;
      }
      // 自己写的（或打开编辑器时信任过的）脚本记为信任：用它新建、以后从资源库里选时不再问
      await trustScripts(findScripts(f));
      const r = await saveForm(f);
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      showToast(r.stored ? `「${f.name}」存进资源库了` : '浏览器不让存：只在这一次打开的页面里');
      closeFormEditor();
      st.onSaved(f, `${r.entry.key}:${f.id}`);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const f = await final();
      if (!f) return;
      await trustScripts(findScripts(f));
      if (await st.onCreate(f, seedRef.current)) closeFormEditor();
    } finally {
      setBusy(false);
    }
  };

  const broken = !!problem || !!current?.error || stuck;
  const crust = form.scripts?.crust?.src ?? '';
  return (
    <div class="modal-backdrop">
      <div class="modal form-editor">
        <div class="row between">
          <h2>{st.original ? '编辑星球形态' : '自己做一个星球形态'}</h2>
        </div>
        {st.original && !st.mine && <p class="muted small">改的是一份副本，原来的「{st.original.name}」不变。</p>}
        <div class="form-grid">
          <div class="form-fields">
            <label>
              <span class="small muted">名字</span>
              <input class="wide-input" value={form.name} maxLength={12} onInput={(e) => setForm({ ...formRef.current, name: (e.target as HTMLInputElement).value })} />
            </label>
            <label>
              <span class="small muted">一句话说明（可以不写）</span>
              <input
                class="wide-input"
                value={form.hint ?? ''}
                maxLength={60}
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  const { hint: _, ...rest } = formRef.current;
                  setForm(v ? { ...rest, hint: v } : rest);
                }}
              />
            </label>
            <label>
              <span class="small muted">从哪种星球改起</span>
              <select value={form.base} onChange={(e) => setForm({ ...formRef.current, base: (e.target as HTMLSelectElement).value as PlanetForm['base'] })}>
                {FORM_BASES.map((t) => (
                  <option value={t}>{planetTypeName(t)}</option>
                ))}
              </select>
            </label>
            {FORM_KNOBS.map((k) => {
              const v = k.read(form);
              return (
                <label class="adj-row" title={k.hint}>
                  <span class="row between">
                    <span>{k.label}</span>
                    <span class="muted">{knobText(k, form, st.radiusKm)}</span>
                  </span>
                  <input type="range" min={k.range[0]} max={k.range[1]} step={k.step} value={v} onInput={(e) => setForm(k.write(formRef.current, Number((e.target as HTMLInputElement).value)))} />
                </label>
              );
            })}
            <details open={!!st.initial.scripts}>
              <summary>脚本</summary>
              <p class="muted small">脚本是一小段程序：布局脚本加大陆块、加岛；地形脚本改每一格的高度、山、丘陵、岩性。不会写也没关系，上面的滑块就够用。</p>
              <ScriptBox
                key={`${st.id}:setup`}
                kind="setup"
                label="布局"
                hint="建星球时运行一次"
                value={form.scripts?.setup?.src ?? ''}
                issue={() => issueOf('setup')}
                apply={applyScript('setup')}
                onDraft={(src) => (drafts.current.setup = src)}
              />
              <ScriptBox
                key={`${st.id}:crust`}
                kind="crust"
                label="地形"
                hint="每一格运行一次"
                value={crust}
                issue={() => issueOf('crust')}
                apply={applyScript('crust')}
                onDraft={(src) => (drafts.current.crust = src)}
              />
              <div class={`seg ${crust ? '' : 'off'}`} title={crust ? '' : '写了地形脚本才起作用'}>
                <button class={form.crustMode !== 'replace' ? 'on' : ''} onClick={() => setForm(withCrustMode(formRef.current, 'modify'))}>
                  在原来的地形上改
                </button>
                <button class={form.crustMode === 'replace' ? 'on' : ''} onClick={() => setForm(withCrustMode(formRef.current, 'replace'))}>
                  完全由脚本决定
                </button>
              </div>
            </details>
          </div>
          <div class="form-preview">
            <Canvas data={shown?.thumb} stale={!current} />
            {shapeProblem ? (
              <p class="script-problem small">{shapeProblem}</p>
            ) : stuck ? (
              <p class="script-problem small">{HUNG}</p>
            ) : current?.error ? (
              <p class="script-problem small">{current.error}</p>
            ) : firstIssue ? (
              <p class="script-problem small">{firstIssue.message}（缩略图里按没有这段脚本算）</p>
            ) : disabled ? (
              <p class="muted small">安全模式下脚本没有运行，缩略图里没有脚本的效果。</p>
            ) : (
              <p class="muted small">{current ? '缩略图是粗略版，新建时用更精细的网格，大格局不变。' : '正在算缩略图…'}</p>
            )}
            <button class="small" onClick={() => setSeed(randomSeed())}>
              换个种子
            </button>
          </div>
        </div>
        {msg && <p class="script-problem small">{msg}</p>}
        {problem && !shapeProblem && <p class="script-problem small">{problem}</p>}
        <div class="row between">
          <span />
          <span class="row">
            <button onClick={closeFormEditor} disabled={busy}>
              取消
            </button>
            <button onClick={() => void save()} disabled={busy || broken} title="存进资源库的“我的资源”，以后新建、在“调整”里都能选">
              存进资源库
            </button>
            <button class="primary" onClick={() => void create()} disabled={busy || broken}>
              用它新建
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

export function FormEditor() {
  const st = formEditor.value;
  if (!st) return null;
  return <Editor key={st.id} st={st} />;
}
