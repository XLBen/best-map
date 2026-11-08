import { ChevronRight, X } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { DIMENSION } from '../../../core/content/link-rules';
import type { PackNode } from '../../../core/packs';
import type { ImportPreview } from '../../../core/packs/closure';
import type { PageCtx } from './pages';
import { type BasketFor, addNow, addRegenButton, skippedLine } from './pick-add';
import { type BasketNode, basketGroups, foldText, hasZeroWeightGroup, soleText, soleValue, whyText } from './pick-look';
import { regenLine } from './pick-other';
import { clearPicks, removePickIn, setPickDest } from './pick-store';
import type { PickView } from './pick-view';

// 资源库面板右栏底下的清单（第六十五轮是导入窗口的右边，第六十七轮搬进面板，第六十八轮“从别的库加”的右栏也用）：加到哪里、将添加的各项、添加。
// 项数就是按钮上的数；一个变量的取值收成一行，能展开；每行 × 去掉（连同为它加的、要它的）

const SHOW_ROWS = 60;
// 变量的取值总收着（只有一种时直接写）；别的上级下面太多时才收
const foldsAt = (n: BasketNode): boolean => (n.row.kind === DIMENSION ? n.children.length > 1 : n.children.length > 8);

// 悬停：去掉后会怎样
function removeTitle(n: BasketNode): string {
  if (n.row.role !== 'follow') return '不添加这一项';
  return `连同要它的一起去掉（${whyText(n.row.because)}）`;
}

interface LineCtx {
  p: ImportPreview;
  source: PackNode;
  ctx: PageCtx;
  key: string;
}

function Line({ n, depth, c }: { n: BasketNode; depth: number; c: LineCtx }) {
  const r = n.row;
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(SHOW_ROWS);
  const folds = foldsAt(n);
  const sole = soleValue(c.p, c.source, r);
  const notes: string[] = [];
  if (r.state === 'rename') notes.push('和原来的并存');
  if (r.state === 'fix' && r.role !== 'follow') notes.push('补回写到的内容');
  // 跟着来的写谁要它；点灰的行时一起勾上的写“为了 X 加的”（pick-store.ts 的 withForNotes）
  if (r.role === 'follow' || r.because[0]?.startsWith('为了')) notes.push(whyText(r.because));
  if (sole) notes.push(soleText(sole));
  const kids = folds && !open ? [] : n.children.slice(0, limit);
  return (
    <>
      <div class="lb-line" style={{ paddingLeft: `${depth * 14}px` }}>
        <span class="lb-line-text">
          <span class="lb-line-name">
            {depth > 0 && <span class="lb-tick">└</span>}
            <span class="ellipsis" title={r.name}>
              {r.name}
            </span>
          </span>
          {notes.length > 0 && <span class="hint lb-line-note">{notes.join('。')}</span>}
        </span>
        {r.kind !== 'field' && (
          <button class="icon-btn lb-x" title={removeTitle(n)} aria-label={removeTitle(n)} onClick={() => removePickIn(c.key, { kind: r.kind, id: r.id }, c.ctx)}>
            <X />
          </button>
        )}
      </div>
      {folds && (
        <button class={`lb-fold ${open ? 'open' : ''}`} style={{ marginLeft: `${(depth + 1) * 14}px` }} onClick={() => setOpen(!open)}>
          <span class="lb-tick">└</span>
          <span class="hint">{foldText(n.children)}</span>
          <ChevronRight />
        </button>
      )}
      {kids.map((x) => (
        <Line key={`${x.row.kind}:${x.row.id}`} n={x} depth={depth + 1} c={c} />
      ))}
      {kids.length > 0 && n.children.length > limit && (
        <button class="small lb-more" onClick={() => setLimit(limit + SHOW_ROWS * 4)}>
          还有 {n.children.length - limit} 项
        </button>
      )}
    </>
  );
}

function Group({ title, nodes, c }: { title: string; nodes: BasketNode[]; c: LineCtx }) {
  const [limit, setLimit] = useState(SHOW_ROWS);
  return (
    <section class="lb-group">
      <h6>{title}</h6>
      {nodes.slice(0, limit).map((n) => (
        <Line key={`${n.row.kind}:${n.row.id}`} n={n} depth={0} c={c} />
      ))}
      {nodes.length > limit && (
        <button class="small lb-more" onClick={() => setLimit(limit + SHOW_ROWS * 4)}>
          还有 {nodes.length - limit} 项
        </button>
      )}
    </section>
  );
}

// “加到：本世界 ▾”：本世界和每个我的库（不能加到正在看的这个库自己）
function DestPick({ v, ctx }: { v: PickView; ctx: PageCtx }) {
  const mine = ctx.lib.filter((e) => e.mine && e.key !== v.key);
  const value = v.dest === 'world' ? 'world' : v.dest.lib;
  return (
    <label class="lb-dest">
      <span class="hint">加到</span>
      <select
        value={value}
        onChange={(e) => {
          const x = (e.target as HTMLSelectElement).value;
          setPickDest(x === 'world' ? 'world' : { lib: x });
        }}
      >
        {ctx.world && <option value="world">本世界</option>}
        {mine.length > 0 && (
          <optgroup label="我的库">
            {mine.map((e) => (
              <option value={e.key}>{e.pack.name}</option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

export function LibBasket({ v, ctx, other }: { v: PickView; ctx: PageCtx; other?: BasketFor }) {
  const p = v.preview;
  const source = v.ask.source;
  const [working, setWorking] = useState(false);
  const groups = useMemo(() => basketGroups(p, source), [p, source]);
  // 要重新生成才用得上时多一个按钮（“添加并重新生成国家”这类）
  const regen = useMemo(() => (p.count ? addRegenButton(v.ask, ctx.lib) : null), [v.ask, ctx.lib, p.count]);
  const line = !regen && v.ask.target ? regenLine(p, v.ask.target) : null;
  const c: LineCtx = { p, source, ctx, key: v.key };
  const run = async (withRegen: boolean) => {
    setWorking(true);
    try {
      await addNow(v, ctx, withRegen, other);
    } finally {
      setWorking(false);
    }
  };
  return (
    <section class="lb-basket">
      <div class="lb-head">
        {other ? (
          <span class="lb-dest">
            <span class="hint">加到</span>
            <b class="ellipsis">{other.to}</b>
          </span>
        ) : (
          <DestPick v={v} ctx={ctx} />
        )}
        <span class="grow" />
        <button class="small" disabled={!v.state.picks.length && !v.state.off.length} onClick={() => clearPicks(v.key)}>
          清空
        </button>
      </div>
      <div class="lb-list">
        {groups.map((g) => (
          <Group key={g.title} title={g.title} nodes={g.nodes} c={c} />
        ))}
        {!p.count && <p class="hint">{other ? '在上面勾要添加的内容' : '在左边勾要添加的内容'}</p>}
      </div>
      {/* 第六十六轮去掉了“自动去掉 N 条写到这里没有的内容”（新手看不懂，也没法做什么）；stripCount 照旧算，测试用 */}
      {(p.dropped.length > 0 || line || hasZeroWeightGroup(p)) && (
        <div class="lb-foot">
          {hasZeroWeightGroup(p) && <p class="hint">组的“多少”是 0，不参与生成；勾整组才参与</p>}
          {p.dropped.length > 0 && (
            <p class="warn small" title={p.dropped.map((d) => `${d.kindLabel}“${d.name}”：${d.reason}`).join('\n')}>
              {skippedLine(p.dropped)}：{p.dropped.slice(0, 3).map((d) => d.name).join('、')}
              {p.dropped.length > 3 ? ' 等' : ''}
            </p>
          )}
          {line && <p class="hint">{line}</p>}
        </div>
      )}
      <div class="lb-actions">
        {regen && (
          <button class="small" disabled={working} title="添加和重新生成是一步，一次撤销全撤" onClick={() => void run(true)}>
            {regen}
          </button>
        )}
        <button class="small primary" disabled={!p.count || working} title="⌘回车" onClick={() => void run(false)}>
          添加 {p.count} 项
        </button>
      </div>
    </section>
  );
}
