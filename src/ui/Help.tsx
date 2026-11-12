import { useMemo, useState } from 'preact/hooks';
import { helpOpen, tool, wizardOpen, world } from '../state';
import { ModalHead } from './common';
import { HELP_KEYS, HELP_START, HELP_STEPS, HELP_TOUCH } from './help-data';
import { type HelpTool, helpTools, noHitsText, nowHelp, searchHelp, toolLine } from './help-search';
import { touchUi } from './touch-ui';

// “更多 → 帮助”（第九十八轮以前叫“上手说明”；新建向导上也有一个“帮助”，按 ? 开关）。
// 第九十九轮：字搬到 help-data.ts，怎么搜、现在这个工具看哪几条在 help-search.ts（纯函数）；这里只画。
//   - 标题下面一个搜索框：按字过滤步骤、工具、按键；没搜到时说一句人话。不自己抢焦点（按 ? 还能关上帮助；点进框里打 ? 是打字）；
//   - 有世界时最上面一小块“现在这个工具”：它自己的那一句、数字键，和讲它、讲这一类的几条；
//   - 下面照旧：“怎么开始”的四句、一步一步、按键；
//   - 第一百轮：“触摸”一段（手指、笔怎么用），触摸设备上排在“按键”前面
export { HELP_START } from './help-data';

function Hits({ q, tools }: { q: string; tools: readonly HelpTool[] }) {
  const hits = useMemo(() => searchHelp(q, tools), [q, tools]);
  if (!hits.total) return <p class="hint help-none">{noHitsText(hits.q)}</p>;
  return (
    <div class="help-hits">
      {hits.tools.length > 0 && (
        <>
          <h5>底部的工具</h5>
          <ul>
            {hits.tools.map((t) => (
              <li>
                <span class="help-where">{t.group} · </span>
                {toolLine(t)}
              </li>
            ))}
          </ul>
        </>
      )}
      {hits.start.length > 0 && (
        <>
          <h5>怎么开始</h5>
          <ul>
            {hits.start.map((t) => (
              <li>{t}</li>
            ))}
          </ul>
        </>
      )}
      {hits.steps.map((s) => (
        <>
          <h5>一步一步 · {s.title}</h5>
          <ul>
            {s.items.map((t) => (
              <li>{t}</li>
            ))}
          </ul>
        </>
      ))}
      {hits.keys.length > 0 && (
        <>
          <h5>按键</h5>
          <KeyTable rows={hits.keys} />
        </>
      )}
      {hits.touch.length > 0 && (
        <>
          <h5>触摸</h5>
          <KeyTable rows={hits.touch} />
        </>
      )}
    </div>
  );
}

// 左边是做什么、右边是怎么做的一张表（按键、触摸）
function KeyTable({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <table class="kv">
      <tbody>
        {rows.map(([k, v]) => (
          <tr>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 现在这个工具：有世界、不在新建向导里时才有
function Now({ tools }: { tools: readonly HelpTool[] }) {
  const t = tools.find((x) => x.id === tool.value);
  if (!t) return null;
  const now = nowHelp(t);
  return (
    <div class="help-now">
      <p class="help-now-title">
        <b>现在这个工具</b>
        <span class="help-where"> · {t.group}</span>
      </p>
      <p class="help-tool">{toolLine(t)}</p>
      {now.items.length > 0 && (
        <ul>
          {now.items.map((x) => (
            <li>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HelpBody() {
  const [q, setQ] = useState('');
  const w = world.value;
  const tools = useMemo(() => helpTools(w), [w]);
  return (
    <div class="modal help" onClick={(e) => e.stopPropagation()}>
      <ModalHead title="帮助" onClose={() => (helpOpen.value = false)} />
      <div class="help-search">
        <input type="search" placeholder="搜：工具、步骤、按键" aria-label="搜帮助" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      {q.trim() ? (
        <Hits q={q} tools={tools} />
      ) : (
        <>
          {w && !wizardOpen.value && <Now tools={tools} />}
          <h5>怎么开始</h5>
          <ul class="help-start">
            {HELP_START.map((t) => (
              <li>{t}</li>
            ))}
          </ul>
          <h5>一步一步</h5>
          <ol class="steps">
            {HELP_STEPS.map((s) => (
              <li>
                <b>{s.title}</b>
                <ul>
                  {s.items.map((t) => (
                    <li>{typeof t === 'string' ? t : t.text}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {/* 触摸设备上先讲触摸，再是按键（外接键盘时用得上）；鼠标下反过来 */}
          {touchUi() && (
            <>
              <h5>触摸</h5>
              <KeyTable rows={HELP_TOUCH} />
            </>
          )}
          <h5>按键</h5>
          <KeyTable rows={HELP_KEYS} />
          {!touchUi() && (
            <>
              <h5>触摸</h5>
              <KeyTable rows={HELP_TOUCH} />
            </>
          )}
          <p class="hint">同样的操作，结果一样；想要别的样子点“换一个”</p>
        </>
      )}
    </div>
  );
}

export function Help() {
  if (!helpOpen.value) return null;
  return (
    <div class="modal-backdrop" onClick={() => (helpOpen.value = false)}>
      <HelpBody />
    </div>
  );
}
