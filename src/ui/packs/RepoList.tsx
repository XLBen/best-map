import { Check, ChevronDown, ChevronRight, GripVertical, LocateFixed } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import type { World } from '../../../core/world';
import { focusOn } from '../camera';
import { canRename, canReorder, sameShelf } from './edit';
import { LINE_H, type Line, scrollToLine, visibleRange } from './lines';
import { type RepoRow, type TreeNode, addCommand, packAddCommand, packRemoveRefs, removeCommand, restoreRowCommand, rowUsage } from './repo';
import { fmt, removeUnused, renameRow, reorderRow, runTrusted, selectRow, swatchOf } from './repo-actions';
import type { Hover } from './RepoPreview';

// 资源库的左栏（第四十五轮）：本世界、资源库两段摊成一长列（lines.ts），只画看得见的几十行，滚动时换。
// 点一项选中（右栏是它的详情与编辑器），双击改名（本世界里的、我的资源里的），拖动换先后（我的资源里的），
// 每一行右边是添加 / 移出；鼠标停着时地图上预览（RepoPreview.ts）

// 树里每深一层缩进多少
const INDENT = 12;

export interface ListCtx {
  w: World | null;
  // 种类是“全部”：每一项后面写是哪一种
  allKinds: boolean;
  sel: string | null;
  toggle: (key: string) => void;
  collapse: (side: string) => void;
  onHover: (h: Hover | null) => void;
  onRun: () => void;
}

// 点了之后跑命令（鼠标移开之前不再预览：不然地图上会先画出“再点一下”的样子）
function useRun(ctx: ListCtx) {
  const [armed, setArmed] = useState(true);
  const hovering = useRef(false);
  // 鼠标停着的时候这一行没了（换了种类、筛掉了、滚出去了）：移开的事件不会来，一并去掉预览
  useEffect(
    () => () => {
      if (hovering.current) ctx.onHover(null);
    },
    [],
  );
  const run = async (cmd: Command | null, busy: string) => {
    if (!cmd) return;
    setArmed(false);
    ctx.onRun();
    await runTrusted(cmd, busy);
  };
  const enter = (h: Hover | null) => {
    hovering.current = true;
    ctx.onHover(armed ? h : null);
  };
  const leave = () => {
    hovering.current = false;
    setArmed(true);
    ctx.onHover(null);
  };
  return { run, enter, leave };
}

export const hoverOf = (row: RepoRow, cmd: Command | null, action: Hover['action']): Hover | null => {
  const style = row.kind.id === 'nameStyle';
  return cmd ? { key: `${row.key}|${action}|${JSON.stringify(cmd)}`, cmd, action, nameOnly: style && action !== 'default' && !row.status.isDefault, names: style } : null;
};

// 正在拖的一项（只有我的资源里的能拖；一列只画看得见的几行，所以记在这里）
let dragging: RepoRow | null = null;

function ItemLine({ row, depth, ctx }: { row: RepoRow; depth: number; ctx: ListCtx }) {
  const { w } = ctx;
  const st = row.status;
  const lib = row.source !== 'world';
  const usage = !lib && w ? rowUsage(row, w) : null;
  const remove = !lib && w ? removeCommand(row, w) : null;
  const restore = !lib && w ? restoreRowCommand(row, w) : null;
  // 添加的命令鼠标停着、点下去时才算（一列几百项，不必每次都算）
  const canAdd = lib && !!w && !st.on && !st.locked;
  const addCmd = () => (w ? addCommand(row, w) : null);
  const { run, enter, leave } = useRun(ctx);
  const [naming, setNaming] = useState(false);
  const [over, setOver] = useState(false);
  const swatch = swatchOf(row);
  const selected = ctx.sel === row.key;
  const why = usage ? `有 ${fmt(usage.count)} 处在用：${usage.label}` : st.locked;
  const renamable = canRename(row);
  const movable = canReorder(row);
  return (
    <div
      class={`repo-row repo-item ${lib && st.on ? 'on' : ''} ${selected ? 'sel' : ''} ${over ? 'drop-before' : ''}`}
      style={{ paddingLeft: `${depth * INDENT + 22}px` }}
      onPointerEnter={() => enter(lib ? (canAdd ? hoverOf(row, addCmd(), 'on') : null) : hoverOf(row, remove ?? restore, 'off'))}
      onPointerLeave={leave}
      draggable={movable && !naming}
      onDragStart={(e) => {
        dragging = row;
        e.dataTransfer?.setData('text/plain', row.key);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        dragging = null;
        setOver(false);
      }}
      onDragOver={(e) => {
        if (!dragging || !sameShelf(dragging, row)) return;
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const from = dragging;
        setOver(false);
        dragging = null;
        if (!from || !sameShelf(from, row)) return;
        e.preventDefault();
        void reorderRow(from, row);
      }}
    >
      {movable && (
        <span class="repo-grip" title="拖动换先后">
          <GripVertical />
        </span>
      )}
      {swatch ? <span class="swatch" style={{ background: swatch }} /> : null}
      {naming ? (
        <input
          class="repo-rename"
          type="text"
          value={row.name}
          ref={(el) => {
            if (el && document.activeElement !== el) {
              el.focus();
              el.select();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setNaming(false);
            }
          }}
          onBlur={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setNaming(false);
            void renameRow(row, v);
          }}
        />
      ) : (
        <button class="repo-name" onClick={() => selectRow(row)} onDblClick={() => renamable && setNaming(true)} title={renamable ? '双击改名' : undefined}>
          {row.name}
        </button>
      )}
      {ctx.allKinds && <span class="hint repo-kind">{row.kind.short}</span>}
      {st.modified && !st.always && <span class="hint repo-mod">改过</span>}
      {st.isDefault && <span class="hint">{row.kind.id === 'mapStyle' ? '在用' : '默认'}</span>}
      <span class="repo-actions">
        {lib ? (
          st.on ? (
            <span class="repo-check" title="已在本世界">
              <Check />
            </span>
          ) : (
            <span title={st.locked}>
              <button class="small" disabled={!canAdd} onClick={() => void run(addCmd(), '正在添加…')}>
                添加
              </button>
            </span>
          )
        ) : st.always ? (
          restore ? (
            <button class="small" title="换回内置的这一项" onClick={() => void run(restore, '正在计算…')}>
              恢复
            </button>
          ) : (
            <span class="hint">总在</span>
          )
        ) : st.locked && !usage ? null : (
          <>
            {usage?.cells?.length ? (
              <button class="small icon ghost" title="在地图上看用到它的地方" onClick={() => focusOn(usage.cells!)}>
                <LocateFixed />
              </button>
            ) : null}
            <span title={why}>
              <button class="small" disabled={!remove} onClick={() => void run(remove, '正在移出…')}>
                移出
              </button>
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function NodeLine({ n, depth, open, side, ctx }: { n: TreeNode; depth: number; open: boolean; side: string; ctx: ListCtx }) {
  const { w } = ctx;
  const lib = side === 'library';
  const { run, enter, leave } = useRun(ctx);
  const canAdd = lib && !!w && n.count > n.on;
  const removable = !lib && !!w && packRemoveRefs(n).length > 0;
  // 整包添加的命令：鼠标停在按钮上、点下去时才算（一棵树上几十个包，不必每次都算）
  const addCmd = () => (w ? packAddCommand(n, w) : null);
  return (
    <div class={`repo-row repo-node ${n.loose ? 'loose' : ''}`} style={{ paddingLeft: `${depth * INDENT}px` }}>
      <button class="repo-twist" onClick={() => ctx.toggle(n.key)} title={open ? '收起' : '展开'}>
        {open ? <ChevronDown /> : <ChevronRight />}
      </button>
      <button class="repo-name" onClick={() => ctx.toggle(n.key)} title={n.description}>
        {n.name}
      </button>
      <span class="hint repo-count">{lib && n.on ? `${n.on}/${n.count}` : n.count}</span>
      <span class="repo-actions">
        {canAdd && (
          <button
            class="small"
            onPointerEnter={() => {
              const cmd = addCmd();
              enter(cmd ? { key: `${n.key}|all|${JSON.stringify(cmd)}`, cmd, action: 'on', nameOnly: false, names: false } : null);
            }}
            onPointerLeave={leave}
            onClick={() => void run(addCmd(), '正在添加…')}
          >
            全部添加
          </button>
        )}
        {removable && (
          <button class="small" title="在用的、移出后地图会变的留着" onClick={() => void removeUnused(n)}>
            移出没用到的
          </button>
        )}
      </span>
    </div>
  );
}

function LineView({ line, ctx }: { line: Line; ctx: ListCtx }) {
  switch (line.t) {
    case 'section':
      return (
        <div class="repo-row repo-section">
          <button class="repo-twist" onClick={() => ctx.collapse(line.side)} title={line.collapsed ? '展开' : '收起'}>
            {line.collapsed ? <ChevronRight /> : <ChevronDown />}
          </button>
          <button class="repo-name" onClick={() => ctx.collapse(line.side)}>
            {line.title}
          </button>
          <span class="hint repo-count">{line.count}</span>
        </div>
      );
    case 'node':
      return <NodeLine n={line.n} depth={line.depth} open={line.open} side={line.side} ctx={ctx} />;
    case 'item':
      return <ItemLine row={line.row} depth={line.depth} ctx={ctx} />;
    case 'empty':
      return <p class="hint repo-empty">{line.text}</p>;
  }
}

// 一长列：只画看得见的（上下多画几行）
export function RepoList({ lines, ctx, reveal }: { lines: readonly Line[]; ctx: ListCtx; reveal?: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 从别处选中的一项（新建、用到本世界后换到本世界里的那一行）：滚到看得见
  useEffect(() => {
    const el = box.current;
    if (!el || !reveal) return;
    const k = lines.findIndex((l) => l.key === reveal);
    if (k < 0) return;
    el.scrollTop = scrollToLine(k, el.scrollTop, el.clientHeight);
  }, [reveal]);
  const [a, b] = visibleRange(top, viewH, lines.length);
  return (
    <div class="repo-tree" ref={box} onScroll={(e) => setTop((e.currentTarget as HTMLDivElement).scrollTop)}>
      <div class="repo-spacer" style={{ height: `${lines.length * LINE_H}px` }}>
        <div class="repo-window" style={{ transform: `translateY(${a * LINE_H}px)` }}>
          {lines.slice(a, b).map((l) => (
            <LineView key={l.key} line={l} ctx={ctx} />
          ))}
        </div>
      </div>
    </div>
  );
}
