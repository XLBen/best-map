import { ChevronRight, X } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { DIMENSION } from '../../../core/content/link-rules';
import type { PackNode } from '../../../core/packs';
import type { ImportPreview, ImportTarget } from '../../../core/packs/closure';
import { regenLine, removeRow, skippedLine } from './page-import';
import { type BasketNode, basketGroups, foldText, hasZeroWeightGroup, soleText, soleValue, whyText } from './page-import-tree';
import type { PageCtx } from './page-source';

// 导入窗口的右边（第六十五轮）：将导入的清单。项数就是按钮上的数；一个变量的取值收成一行，能展开；每行 × 去掉

const SHOW_ROWS = 60;
// 变量的取值总收着（只有一种时直接写）；别的上级下面太多时才收
const foldsAt = (n: BasketNode): boolean => (n.row.kind === DIMENSION ? n.children.length > 1 : n.children.length > 8);

// 悬停：去掉后会怎样
function removeTitle(n: BasketNode): string {
  if (n.row.role !== 'follow') return '不导入这一项';
  return `连同要它的一起去掉（${whyText(n.row.because)}）`;
}

function Line({ n, depth, p, source, ctx }: { n: BasketNode; depth: number; p: ImportPreview; source: PackNode; ctx: PageCtx }) {
  const r = n.row;
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(SHOW_ROWS);
  const folds = foldsAt(n);
  const sole = soleValue(p, source, r);
  const notes: string[] = [];
  if (r.state === 'rename') notes.push('和原来的并存');
  if (r.state === 'fix') notes.push('补回写到的内容');
  if (r.role === 'follow') notes.push(whyText(r.because));
  if (sole) notes.push(soleText(sole));
  const kids = folds && !open ? [] : n.children.slice(0, limit);
  return (
    <>
      <div class="imp-line" style={{ paddingLeft: `${depth * 14}px` }}>
        <span class="imp-line-text">
          <span class="imp-line-name">
            {depth > 0 && <span class="imp-tick">└</span>}
            <span class="ellipsis" title={r.name}>
              {r.name}
            </span>
          </span>
          {notes.length > 0 && <span class="hint imp-line-note">{notes.join('。')}</span>}
        </span>
        {r.kind !== 'field' && (
          <button class="icon-btn imp-x" title={removeTitle(n)} onClick={() => removeRow({ kind: r.kind, id: r.id }, ctx)}>
            <X />
          </button>
        )}
      </div>
      {folds && (
        <button class={`imp-fold ${open ? 'open' : ''}`} style={{ marginLeft: `${(depth + 1) * 14}px` }} onClick={() => setOpen(!open)}>
          <span class="imp-tick">└</span>
          <span class="hint">{foldText(n.children)}</span>
          <ChevronRight />
        </button>
      )}
      {kids.map((c) => (
        <Line key={`${c.row.kind}:${c.row.id}`} n={c} depth={depth + 1} p={p} source={source} ctx={ctx} />
      ))}
      {kids.length > 0 && n.children.length > limit && (
        <button class="small imp-more" onClick={() => setLimit(limit + SHOW_ROWS * 4)}>
          还有 {n.children.length - limit} 项
        </button>
      )}
    </>
  );
}

function Group({ title, nodes, p, source, ctx }: { title: string; nodes: BasketNode[]; p: ImportPreview; source: PackNode; ctx: PageCtx }) {
  const [limit, setLimit] = useState(SHOW_ROWS);
  return (
    <section class="imp-basket-group">
      <h6>{title}</h6>
      {nodes.slice(0, limit).map((n) => (
        <Line key={`${n.row.kind}:${n.row.id}`} n={n} depth={0} p={p} source={source} ctx={ctx} />
      ))}
      {nodes.length > limit && (
        <button class="small imp-more" onClick={() => setLimit(limit + SHOW_ROWS * 4)}>
          还有 {nodes.length - limit} 项
        </button>
      )}
    </section>
  );
}

export function ImportBasket({ p, source, target, ctx }: { p: ImportPreview | null; source: PackNode | null; target: ImportTarget | null; ctx: PageCtx }) {
  const groups = useMemo(() => (p && source ? basketGroups(p, source) : []), [p, source]);
  const regen = p && target ? regenLine(p, target) : null;
  return (
    <aside class="imp-basket">
      <h5>将导入 {p?.count ?? 0} 项</h5>
      <div class="imp-basket-list">
        {p && source && groups.map((g) => <Group key={g.title} title={g.title} nodes={g.nodes} p={p} source={source} ctx={ctx} />)}
        {!p?.count && <p class="hint">在左边勾要导入的内容</p>}
      </div>
      {p && (p.stripCount > 0 || p.dropped.length > 0 || regen || hasZeroWeightGroup(p)) && (
        <div class="imp-basket-foot">
          {p.stripCount > 0 && <p class="hint">自动去掉 {p.stripCount} 条写到这里没有的内容</p>}
          {hasZeroWeightGroup(p) && <p class="hint">组的比重是 0，不参与生成；勾整组才参与</p>}
          {p.dropped.length > 0 && (
            <p class="warn small" title={p.dropped.map((d) => `${d.kindLabel}“${d.name}”：${d.reason}`).join('\n')}>
              {skippedLine(p.dropped)}：{p.dropped.slice(0, 3).map((d) => d.name).join('、')}
              {p.dropped.length > 3 ? ' 等' : ''}
            </p>
          )}
          {regen && <p class="hint">{regen}</p>}
        </div>
      )}
    </aside>
  );
}
