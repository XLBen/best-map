import { Check, ChevronDown, ChevronRight, Download, Ellipsis, LocateFixed, Pencil, Plus, Save, Trash2, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { type ContentKind, enableCommand, itemId, itemName, kindOf } from '../../../core/content/registry';
import { hexToRgb } from '../../../core/export';
import type { IslandType } from '../../../core/island-types';
import { PACK_MAX_CHARS, packFileName, readPack } from '../../../core/packs';
import type { World } from '../../../core/world';
import { library, removeItem, saveItem } from '../../library';
import type { HighlightLayer } from '../../render/colors';
import {
  adjustPreviewWorld,
  askUser,
  cancelWorldPreview,
  download,
  exactDelay,
  exec,
  execAdjust,
  focusSpecies,
  knowIsolation,
  openPanel,
  openWaterTypeEditor,
  planTidy,
  previewWorld,
  sheet,
  showToast,
  world,
  worldPreviewError,
} from '../../state';
import { trustScripts, untrustedScripts } from '../../trust';
import { focusOn } from '../camera';
import { scriptTrustText } from '../copy';
import { category, setCategory, setTool } from '../defs/tools';
import { createAndUse as createIslandType, islandSwatch, requestIslandTypeEditor } from '../panels/islandTypes';
import { createAndUse as createWaterType } from '../panels/waterTypes';
import { EditorKind, FieldsBox } from './ContentEditor';
import { type Obj, blankItem, copyItem, editorIssues } from './fields';
import {
  GOV_KINDS,
  HUMAN_KINDS,
  SETTLE_KINDS,
  type RepoRow,
  type TreeNode,
  addCommand,
  canDeleteFromLibrary,
  defaultStyleCommand,
  editStart,
  filterTree,
  itemPack,
  packAddCommand,
  packRemoveRefs,
  packTree,
  removeCommand,
  repoKinds,
  repoRows,
  restoreRowCommand,
  rowUsage,
  saveableItem,
} from './repo';
import { isolationNote } from './Scripts';
import { type RepoEdit, type RepoState, closeRepo, fileLabel, openPackImport, openPackList, openRepo, packDialog, patchRepo, repo } from './store';
import { missingCount, restyleOffer } from './styles';
import { tidyWorld } from './tidy';

// 资源库（第二十八轮以前叫仓库；世界 → 资源库…，工具里的“从资源库添加…”）：浮在地图左边，不挡地图。
// 第二十九轮改成两栏，都按资源包分组：
//   左栏“本世界”：世界里的每一项按记着的来源（small.origin）归到资源库的包（大包 ▸ 小包），本世界做的放在最后的“离群”。
//     每一项“移出”（在用的灰掉，悬停写用在哪里、几处，能定位）；一个包“移出没用到的”（在副本上试过、地图不变的才移）。
//   右栏“资源库”：内置的、我的、装上的资源包，各是一棵树。包那一行“全部添加”（一整步，记上来源），展开后每一项“添加”；
//     已在本世界的打勾、变暗。（第三十轮起“通用 ▸ 基础”也是普通的包，能添加、移出）
//   顶上：种类（全部或一种；从选择器的“从资源库添加…”打开时已经筛好）、搜索、“⋯”（从文件导入、从本世界存进资源库、整理本世界、资源包）。
//   点一项的名字：在它下面展开说明、编辑、导出文件、从库里删除（只限我的）。编辑器沿用通用编辑器和生态、河、湖、岛各自的编辑器。
// 鼠标停在一项上，地图上先画出添加、移出之后的样子（在 Worker 里的世界副本上执行同一条命令）。窄屏时两栏上下排

const WHITE: [number, number, number] = [255, 255, 255];
const fmt = (n: number) => n.toLocaleString('en-US');
// 树里每深一层缩进多少
const INDENT = 12;

// 有自己编辑器的几种（编辑的是世界里的那一项）
const DEDICATED = new Set(['biome', 'riverType', 'lakeType', 'islandType']);

// 添加、移出、“默认”之前：没信任过的脚本先问
async function runTrusted(cmd: Command, busy: string): Promise<boolean> {
  const list = await untrustedScripts(cmd);
  if (list.length) {
    await knowIsolation();
    const v = await askUser({
      title: '信任脚本',
      text: `${scriptTrustText(list.length)}${isolationNote()}`,
      scripts: list,
      choices: [
        { value: 'ok', label: '信任并启用', primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (v !== 'ok') return false;
    await trustScripts(list);
  }
  return execAdjust(cmd, busy);
}

function swatchOf(row: RepoRow): string | null {
  if (row.kind.id === 'islandType') return islandSwatch(row.item as IslandType);
  const c = (row.item as { color?: unknown }).color;
  return typeof c === 'string' && c.startsWith('#') ? c : null;
}

// 展开后的几个示例名字（地名风格）：每类地物的第一个，最多三类
const sampleCache = new WeakMap<object, string>();
function sampleLine(row: RepoRow): string {
  const it = row.item as object;
  let s = sampleCache.get(it);
  if (s === undefined) {
    try {
      s = (row.kind.samples?.(row.item, 1) ?? [])
        .slice(0, 3)
        .map((g) => g.lines[0])
        .filter(Boolean)
        .join('、');
    } catch {
      s = '';
    }
    sampleCache.set(it, s);
  }
  return s;
}

const descOf = (row: RepoRow): string => {
  const it = row.item as { description?: unknown; hint?: unknown };
  const d = it.description ?? it.hint;
  return typeof d === 'string' ? d : '';
};

// ---------- 停一下预览 ----------

// nameOnly：只是多一种能选的风格（地图上不变）；names：地图上只有地名变（世界默认的风格换了）
type Hover = { key: string; cmd: Command; action: 'on' | 'off' | 'default'; nameOnly: boolean; names: boolean };
type Note = { key: string; text: string; warn?: boolean } | null;

const ACTION_TEXT = { on: '添加后', off: '移出后', default: '设为默认后' } as const;

function usePreview(w: World | null) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [note, setNote] = useState<Note>(null);
  // 放到地图上的预览是哪条命令的（JSON，与 execAdjust 认的一样：点下去时直接采用算好的结果）
  const mine = useRef('');
  // 点下去了：预览的世界留到执行的结果换上（execAdjust 自己去掉），不先闪回原样
  const keep = useRef(false);
  const drop = () => {
    cancelWorldPreview();
    if (!keep.current && mine.current && adjustPreviewWorld.value?.key === mine.current) adjustPreviewWorld.value = null;
    keep.current = false;
    mine.current = '';
  };
  useEffect(() => {
    if (!hover || !w) {
      setNote(null);
      drop();
      return;
    }
    keep.current = false;
    const { key, cmd, action } = hover;
    let live = true;
    const t = setTimeout(async () => {
      const untrusted = await untrustedScripts(cmd);
      if (!live) return;
      if (untrusted.length) {
        setNote({ key, text: '有没信任过的脚本，添加时先问' });
        return;
      }
      if (hover.nameOnly) {
        setNote({ key, text: action === 'on' ? '添加后可在“地名”里选用' : '移出后不再列在“地名”里' });
        return;
      }
      setNote({ key, text: '正在计算…' });
      const r = await previewWorld(cmd);
      if (!live) return;
      if (!r) {
        const why = worldPreviewError(cmd);
        setNote({ key, text: why ? `用不上：${why}` : '预览失败', warn: !!why });
        return;
      }
      // 新加的生态长在哪里（按各自的颜色淡淡涂上），会变的格描边
      const had = new Set(w.small.species.map((s) => s.id));
      const sp = r.world.small.species;
      const isNew = sp.map((s) => !had.has(s.id));
      const byNew = new Map<number, number[]>();
      const dom = r.world.derived.dominant;
      for (let i = 0; i < dom.length; i++) {
        const s = dom[i];
        if (s >= 0 && isNew[s]) (byNew.get(s) ?? byNew.set(s, []).get(s)!).push(i);
      }
      const layers: HighlightLayer[] = [
        { cells: r.result.changedCells, color: WHITE, pattern: 'outline' },
        ...[...byNew].map(([s, cells]): HighlightLayer => ({ cells, color: hexToRgb(sp[s].color), alpha: 0.35 })),
      ];
      const cmdKey = JSON.stringify(cmd);
      adjustPreviewWorld.value = { key: cmdKey, base: r.base, world: r.world, layers };
      mine.current = cmdKey;
      let grown = 0;
      for (const c of byNew.values()) grown += c.length;
      const changed = r.result.changedCells.length;
      const text = hover.names
        ? action === 'default'
          ? '地名按这种风格重起'
          : '移出后地名按内置中文重起'
        : isNew.some(Boolean)
            ? grown
              ? `${ACTION_TEXT[action]} ${fmt(grown)} 格变成新生态`
              : '新生态在这里长不出来'
            : changed
              ? `${ACTION_TEXT[action]} ${fmt(changed)} 格会变`
              : '地图上没有变化';
      setNote({ key, text });
    }, exactDelay(300));
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [hover?.key, w]);
  // 关上资源库：去掉地图上的预览
  useEffect(() => drop, []);
  const settle = () => {
    keep.current = true;
    setHover(null);
  };
  return { hover, setHover, settle, note: note && hover && note.key === hover.key ? note : null };
}

// ---------- 一项 ----------

// 存进资源库（“我的资源”）
async function saveRow(row: RepoRow) {
  const item = saveableItem(row);
  if (item === null) return;
  const r = await saveItem(row.kind.pack.key, item);
  if (!r.ok) showToast(r.error, true);
  else showToast(r.stored ? `“${row.name}”已存进资源库（我的资源）` : '存不进浏览器：只在这次打开的页面里', !r.stored);
}

// 单独这一项导出成文件
const exportRow = (row: RepoRow) => {
  const pack = itemPack(row);
  download(packFileName(pack), JSON.stringify(pack, null, 2), 'application/json');
};

// 从资源库里删掉（只有我的；先问）
async function deleteRow(row: RepoRow) {
  if (!canDeleteFromLibrary(row)) return;
  const v = await askUser({
    title: `从资源库删除“${row.name}”`,
    text: '用过它的世界不受影响（世界里有自己的一份）。',
    choices: [
      { value: 'delete', label: '删除', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'delete') return;
  const r = await removeItem(row.entry!, row.kind.pack.key, row.id);
  showToast(r.ok ? `“${row.name}”已从资源库删除` : (r.error ?? '删不了'), !r.ok);
}

// 两栏共用的：世界、预览、展开着的项与包
interface TreeCtx {
  w: World | null;
  side: 'world' | 'library';
  // 种类是“全部”：每一项后面写是哪一种
  allKinds: boolean;
  // 在搜索：包都展开
  searching: boolean;
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
  detail: string | null;
  setDetail: (key: string | null) => void;
  onHover: (h: Hover | null) => void;
  onRun: () => void;
}

// 点了之后跑命令（鼠标移开之前不再预览：不然地图上会先画出“再点一下”的样子）
function useRun(ctx: TreeCtx) {
  const [armed, setArmed] = useState(true);
  const hovering = useRef(false);
  // 鼠标停着的时候这一行没了（换了种类、筛掉了、打开了编辑器）：移开的事件不会来，一并去掉预览
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
  return { run, enter, leave, armed };
}

function ItemRow({ row, depth, ctx }: { row: RepoRow; depth: number; ctx: TreeCtx }) {
  const { w, side } = ctx;
  const st = row.status;
  const lib = side === 'library';
  const add = lib && w ? addCommand(row, w) : null;
  const usage = !lib && w ? rowUsage(row, w) : null;
  const remove = !lib && w ? removeCommand(row, w) : null;
  const restore = !lib && w ? restoreRowCommand(row, w) : null;
  const style = row.kind.id === 'nameStyle';
  const main = lib ? add : (remove ?? restore);
  const { run, enter, leave } = useRun(ctx);
  const hoverOf = (cmd: Command | null, action: Hover['action']): Hover | null =>
    cmd ? { key: `${row.key}|${action}|${JSON.stringify(cmd)}`, cmd, action, nameOnly: style && action !== 'default' && !st.isDefault, names: style } : null;
  const swatch = swatchOf(row);
  const desc = descOf(row);
  const opened = ctx.detail === row.key;
  const why = usage ? `有 ${fmt(usage.count)} 处在用：${usage.label}` : st.locked;
  return (
    <>
      <div
        class={`repo-row repo-item ${lib && st.on ? 'on' : ''} ${opened ? 'open' : ''}`}
        style={{ paddingLeft: `${depth * INDENT + 22}px` }}
        onPointerEnter={() => enter(hoverOf(main, lib ? 'on' : 'off'))}
        onPointerLeave={leave}
      >
        {swatch ? <span class="swatch" style={{ background: swatch }} /> : null}
        <button class="repo-name" onClick={() => ctx.setDetail(opened ? null : row.key)} title={desc || undefined}>
          {row.name}
        </button>
        {ctx.allKinds && <span class="hint repo-kind">{row.kind.short}</span>}
        {st.isDefault && <span class="hint">默认</span>}
        <span class="repo-actions">
          {lib ? (
            st.on ? (
              <span class="repo-check" title="已在本世界">
                <Check />
              </span>
            ) : st.always ? (
              <span class="hint">总在</span>
            ) : (
              <span title={st.locked}>
                <button class="small" disabled={!add} onClick={() => void run(add, '正在添加…')}>
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
      {opened && <ItemDetail row={row} depth={depth} ctx={ctx} run={run} hoverOf={hoverOf} />}
    </>
  );
}

// 点开一项：说明、示例、在用的地方，编辑、设为默认、存进资源库、导出文件、从库里删除
function ItemDetail({
  row,
  depth,
  ctx,
  run,
  hoverOf,
}: {
  row: RepoRow;
  depth: number;
  ctx: TreeCtx;
  run: (cmd: Command | null, busy: string) => Promise<void>;
  hoverOf: (cmd: Command | null, action: Hover['action']) => Hover | null;
}) {
  const { w, side } = ctx;
  const st = row.status;
  const desc = descOf(row);
  const style = row.kind.id === 'nameStyle';
  const sample = style ? sampleLine(row) : '';
  const usage = side === 'world' && w ? rowUsage(row, w) : null;
  const def = w && style ? defaultStyleCommand(row, w) : null;
  const canEdit = DEDICATED.has(row.kind.id) ? st.on && side === 'world' : row.kind.id !== 'planetForm' && row.kind.fields.length > 0;
  // 本世界做的（离群）：存进“我的资源”
  const saveable = side === 'world' && !row.path && !st.always && saveableItem(row) !== null;
  return (
    <div class="repo-detail" style={{ paddingLeft: `${depth * INDENT + 22}px` }}>
      {desc && <p class="hint">{desc}</p>}
      {sample && <p class="small repo-sample">{sample}</p>}
      {!st.on && st.rename && <p class="hint">本世界里已有另一份，添加后叫“{st.rename}”</p>}
      {st.locked && !usage && <p class="hint">{st.locked}</p>}
      {usage && (
        <p class="hint">
          有 {fmt(usage.count)} 处在用：{usage.label}
        </p>
      )}
      <div class="row wrap repo-detail-actions">
        {canEdit && (
          <button class="small" title={row.source === 'builtin' && !st.on && !st.always ? '复制一份改' : undefined} onClick={() => editRow(row)}>
            <Pencil /> 编辑
          </button>
        )}
        {def && (
          <button class="small" onPointerEnter={() => ctx.onHover(hoverOf(def, 'default'))} onPointerLeave={() => ctx.onHover(null)} onClick={() => void run(def, '正在起名…')}>
            设为默认
          </button>
        )}
        {saveable && (
          <button class="small" title="别的世界也能用" onClick={() => void saveRow(row)}>
            <Save /> 存进资源库
          </button>
        )}
        <button class="small" title="单独这一项导出成文件" onClick={() => exportRow(row)}>
          <Download /> 导出文件
        </button>
        {canDeleteFromLibrary(row) && (
          <button class="small danger" title="用过它的世界不受影响" onClick={() => void deleteRow(row)}>
            <Trash2 /> 从库里删除
          </button>
        )}
      </div>
    </div>
  );
}

// 本世界一栏的一个包：移出没用到的（在副本上试，地图会变的、在用的留着）
async function removeUnused(n: TreeNode) {
  const refs = packRemoveRefs(n);
  if (!refs.length) return;
  const plan = await planTidy(refs);
  if (!plan) return;
  if (!plan.command) {
    showToast(plan.kept.length ? `移出后地图会变：${plan.kept[0].name}` : '都在用');
    return;
  }
  const ok = await exec(plan.command, '正在移出…');
  if (ok && plan.kept.length) showToast(`${plan.kept.length} 项移出后地图会变，留着`);
}

function NodeRow({ n, depth, ctx }: { n: TreeNode; depth: number; ctx: TreeCtx }) {
  const { w, side } = ctx;
  const open = ctx.searching || ctx.open.has(n.key);
  const lib = side === 'library';
  const { run, enter, leave } = useRun(ctx);
  const canAdd = lib && !!w && n.count > n.on;
  const removable = !lib && !!w && packRemoveRefs(n).length > 0;
  // 整包添加的命令：鼠标停在按钮上、点下去时才算（一棵树上几十个包，不必每次都算）
  const addCmd = () => (w ? packAddCommand(n, w) : null);
  return (
    <>
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
      {open && (
        <>
          {n.children.map((c) => (
            <NodeRow key={c.key} n={c} depth={depth + 1} ctx={ctx} />
          ))}
          {n.rows.map((r) => (
            <ItemRow key={r.key} row={r} depth={depth} ctx={ctx} />
          ))}
        </>
      )}
    </>
  );
}

// 编辑：生态、河、湖、岛的种类打开各自的编辑器；别的用通用编辑器（内置中文、没启用的内置项复制一份改）
function editRow(row: RepoRow) {
  const wid = row.status.worldId ?? row.id;
  switch (row.kind.id) {
    case 'biome':
      focusSpecies.value = wid;
      sheet.value = 'species';
      return;
    case 'riverType':
    case 'lakeType':
      openWaterTypeEditor(row.kind.id === 'riverType' ? 'river' : 'lake', wid);
      return;
    case 'islandType':
      if (category.value !== 'terrain') setTool('island');
      requestIslandTypeEditor(wid);
      openPanel.value = 'cat:terrain';
      return;
  }
  const kind = row.kind.id;
  // 总在的内置项（地形类别、通用资源）：改的是世界里的那一份（同 id，用到世界就换掉内置的）
  if (row.status.always) {
    patchRepo({ edit: { item: structuredClone(editStart(row, world.value)) as Obj, how: 'edit', worldId: row.id, kind } });
    return;
  }
  const copy = row.status.locked || (row.source === 'builtin' && !row.status.on);
  const item = copy ? copyItem(row.kind, row.item, takenIds(row.kind)) : (structuredClone(row.item) as Obj);
  patchRepo({ edit: { item, how: copy ? 'copy' : 'edit', kind, ...(row.status.on && !copy ? { worldId: wid } : {}) } });
}

// 新建：有自己编辑器的在那里新建，别的用登记的空样子
function newItem(kind: ContentKind) {
  switch (kind.id) {
    case 'biome':
      sheet.value = 'species';
      return;
    case 'riverType':
    case 'lakeType':
      void createWaterType(kind.id === 'riverType' ? 'river' : 'lake', null);
      return;
    case 'islandType':
      if (category.value !== 'terrain') setTool('island');
      void createIslandType(null);
      return;
  }
  const item = blankItem(kind, takenIds(kind));
  if (item) patchRepo({ edit: { item, how: 'new', kind: kind.id } });
}

// 从别处打开资源库的一种（“城市 ⋯”里的“资源库…”，工具里的“从资源库添加…”）
export function openRepoKind(kindId: string, filter?: RepoState['filter']) {
  openRepo({ kind: kindId, edit: undefined, ...(filter ? { filter } : {}) });
}
// 打开资源库的一种，同时新建一项（底部条上的“新类型…”）
export function openNewItem(kindId: string) {
  const kind = kindOf(kindId);
  if (!kind) return;
  openRepoKind(kindId);
  newItem(kind);
}

// 这一种里已用的 id（世界里的、资源库里的）：新建、复制时避开
function takenIds(kind: ContentKind): Set<string> {
  const w = world.value;
  return new Set(repoRows(kind, w, library.value).map((r) => r.id).concat(w ? kind.inWorld(w).map((x) => itemId(kind, x)) : []));
}

const canNew = (kind: ContentKind) => DEDICATED.has(kind.id) || !!kind.blank;

// ---------- 编辑器 ----------

function EditorView({ kind, edit, w }: { kind: ContentKind; edit: RepoEdit; w: World | null }) {
  const [seed, setSeed] = useState(1);
  const item = edit.item;
  const { errors, notes } = useMemo(() => editorIssues(kind, item, w), [kind, item, w]);
  const samples = useMemo(() => {
    if (errors.length || !kind.samples) return [];
    try {
      return kind.samples(kind.schema.parse(item), seed);
    } catch {
      return [];
    }
  }, [kind, item, seed, errors.length]);
  const [working, setWorking] = useState(false);
  const set = (v: Obj) => patchRepo({ edit: { ...edit, item: v } });
  const name = itemName(kind, item);
  const title = edit.how === 'new' ? `新的${kind.label}` : edit.how === 'copy' ? `${kind.label} · 副本` : `${kind.label} · ${name}`;
  const ok = !errors.length;
  const save = async () => {
    setWorking(true);
    try {
      const r = await saveItem(kind.pack.key, item);
      if (!r.ok) showToast(r.error, true);
      else showToast(r.stored ? `“${name}”已存进资源库（我的资源）` : '存不进浏览器：只在这次打开的页面里', !r.stored);
    } finally {
      setWorking(false);
    }
  };
  const apply = async () => {
    if (!w) return;
    setWorking(true);
    try {
      const cmd = enableCommand(kind, item, w);
      if (await runTrusted(cmd, '正在计算…')) patchRepo({ edit: { ...edit, how: 'edit', worldId: itemId(kind, item) } });
    } finally {
      setWorking(false);
    }
  };
  return (
    <div class="repo-editor">
      <div class="row between">
        <h3>{title}</h3>
        <button onClick={() => patchRepo({ edit: undefined })}>返回</button>
      </div>
      <EditorKind.Provider value={kind.id}>
        <FieldsBox fields={kind.fields} value={item} onChange={set} issues={errors} />
      </EditorKind.Provider>
      {errors.length > 0 && (
        <div class="box pack-problems">
          <b class="small">要改</b>
          <ul class="small">
            {errors.slice(0, 8).map((e) => (
              <li>
                {e.where ? `${e.where}：` : ''}
                {e.message}
              </li>
            ))}
            {errors.length > 8 && <li>还有 {errors.length - 8} 处…</li>}
          </ul>
        </div>
      )}
      {notes.map((n) => (
        <p class="hint warn">{n}</p>
      ))}
      {samples.length > 0 && (
        <section class="ed-samples">
          <div class="row between">
            <h5>示例</h5>
            <button class="small" onClick={() => setSeed(seed + 1)}>
              换一批
            </button>
          </div>
          {samples.map((g) => (
            <div class="ed-sample">
              <span class="hint">{g.label}</span>
              <span>{g.lines.join('、')}</span>
            </div>
          ))}
        </section>
      )}
      <div class="row between repo-editor-foot">
        <button disabled={!ok} onClick={() => patchRepo({ edit: { item: copyItem(kind, item, takenIds(kind)), how: 'copy', kind: kind.id } })}>
          复制
        </button>
        <span class="row">
          <button disabled={!ok || working} onClick={() => void save()} title="存进资源库的“我的资源”，别的世界也能用">
            存进资源库
          </button>
          <button class="primary" disabled={!ok || working || !w} onClick={() => void apply()} title={edit.worldId ? '换掉本世界里的这一项' : '添加到本世界'}>
            用到本世界
          </button>
        </span>
      </div>
    </div>
  );
}

// ---------- 角落的“⋯” ----------

function importFile(file: File) {
  if (file.size > 3 * PACK_MAX_CHARS) {
    openPackImport({ ok: false, errors: [`文件太大（${Math.round(file.size / 1e6)} MB），不是资源包`] }, file.name);
    return;
  }
  void file.text().then((text) => openPackImport(readPack(text, fileLabel(file.name)), file.name));
}

function CornerMenu({ w }: { w: World | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, [open]);
  const item = (label: string, title: string, run: () => void, disabled = false) => (
    <button
      class="item"
      disabled={disabled}
      title={title}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      <span class="grow">{label}</span>
    </button>
  );
  return (
    <div class="repo-corner" ref={box}>
      <button class={`icon-btn ${open ? 'open' : ''}`} title="导入、存进资源库、整理" onClick={() => setOpen(!open)}>
        <Ellipsis />
      </button>
      {open && (
        <div class="repo-menu menu">
          <label class="item file-item" title="资源包只装进资源库">
            <span class="grow">从文件导入…</span>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(ev) => {
                const f = (ev.target as HTMLInputElement).files?.[0];
                if (f) importFile(f);
                (ev.target as HTMLInputElement).value = '';
                setOpen(false);
              }}
            />
          </label>
          {item('从本世界存进资源库…', '挑几样存成一个资源包', () => (packDialog.value = { view: 'export' }), !w)}
          {item('整理本世界…', '移出哪里都没用到的内容', () => void tidyWorld(), !w)}
          {item('资源包…', '资源库里的包：导出、删除', openPackList)}
        </div>
      )}
    </div>
  );
}

// 生成、重新生成人文在“文化 ⋯”里
function openHuman() {
  closeRepo();
  setCategory('culture');
  openPanel.value = 'cat:culture';
}
function openSettlements() {
  closeRepo();
  setCategory('settlements');
  openPanel.value = 'cat:settlements';
}
function openCountries() {
  closeRepo();
  setCategory('countries');
  openPanel.value = 'cat:countries';
}

// 种类的下拉框
function KindSelect({ value }: { value: string }) {
  return (
    <select class="repo-kind-select" value={value} title="只看一种" onChange={(e) => patchRepo({ kind: (e.target as HTMLSelectElement).value, edit: undefined })}>
      <option value="all">全部</option>
      {repoKinds().map((k) => (
        <option value={k.id}>{k.label}</option>
      ))}
    </select>
  );
}

function Column({ title, nodes, count, ctx, empty }: { title: string; nodes: readonly TreeNode[]; count: number; ctx: TreeCtx; empty: string }) {
  return (
    <section class="repo-col">
      <h5 class="repo-col-head">
        {title} <span class="hint">{count}</span>
      </h5>
      <div class="repo-tree">
        {nodes.map((n) => (
          <NodeRow key={n.key} n={n} depth={0} ctx={ctx} />
        ))}
        {!nodes.length && <p class="hint">{empty}</p>}
      </div>
    </section>
  );
}

// ---------- 整个资源库 ----------

export function RepoPanel() {
  const st = repo.value;
  const w = world.value;
  const lib = library.value;
  const preview = usePreview(st && !st.edit ? w : null);
  const kindId = st?.kind && (st.kind === 'all' || kindOf(st.kind)) ? st.kind : 'all';
  const kind = kindId === 'all' ? null : (kindOf(kindId) ?? null);
  const tree = useMemo(() => (st ? packTree(w, lib, kindId) : { world: [], library: [] }), [w, lib, kindId, !!st]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [detail, setDetail] = useState<string | null>(null);
  // 只看一个包：整个展开
  useEffect(() => {
    const top = st?.entry ? tree.library.find((n) => n.entry === st.entry) : undefined;
    if (!top) return;
    const keys: string[] = [];
    const walk = (n: TreeNode) => {
      keys.push(n.key);
      n.children.forEach(walk);
    };
    walk(top);
    setOpen((s) => new Set([...s, ...keys]));
  }, [st?.entry, kindId, !!st?.entry && tree.library.some((n) => n.entry === st.entry)]);
  if (!st) return null;
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const searching = !!st.query.trim();
  const base = { w, allKinds: !kind, searching, open, toggle, detail, setDetail, onHover: preview.setHover, onRun: preview.settle };
  const libNodes = filterTree(st.entry ? tree.library.filter((n) => n.entry === st.entry) : tree.library, st.query, st.filter === 'off');
  const worldNodes = filterTree(tree.world, st.query);
  const entryName = st.entry ? lib.find((e) => e.key === st.entry)?.pack.name : undefined;
  const editKind = st.edit ? (kindOf(st.edit.kind ?? kindId) ?? null) : null;
  const styleView = !kind || kind.id === 'nameStyle';
  const missing = styleView && w ? missingCount(w.small) : 0;
  const restyle = styleView && w ? restyleOffer(w) : null;
  const sum = (list: readonly TreeNode[]) => list.reduce((a, n) => a + n.count, 0);
  return (
    <div class="repo">
      <div class="popover-head">
        <b>资源库</b>
        <span class="row">
          <CornerMenu w={w} />
          <button class="icon-btn" onClick={closeRepo} title="关闭">
            <X />
          </button>
        </span>
      </div>
      {st.edit && editKind ? (
        <div class="repo-body">
          <EditorView key={editKind.id} kind={editKind} edit={st.edit} w={w} />
        </div>
      ) : (
        <>
          <div class="repo-tools">
            <KindSelect value={kindId} />
            <input class="grow" type="search" placeholder="搜索" value={st.query} onInput={(e) => patchRepo({ query: (e.target as HTMLInputElement).value })} />
            {kind && canNew(kind) && (
              <button class="small" onClick={() => newItem(kind)} title={`新建${kind.label}`}>
                <Plus /> 新建
              </button>
            )}
          </div>
          {(st.entry || st.filter === 'off' || missing > 0 || kind?.pack.note) && (
            <div class="repo-notes">
              {st.entry && (
                <span class="chip static">
                  只看“{entryName ?? st.entry}”
                  <button class="small icon ghost" title="看全部" onClick={() => patchRepo({ entry: undefined })}>
                    <X />
                  </button>
                </span>
              )}
              {st.filter === 'off' && (
                <span class="chip static">
                  不在本世界的
                  <button class="small icon ghost" title="看全部" onClick={() => patchRepo({ filter: 'all' })}>
                    <X />
                  </button>
                </span>
              )}
              {kind?.pack.note && <span class="hint">{kind.pack.note}</span>}
              {missing > 0 && <span class="hint warn">{missing} 处用的风格已移出本世界，按世界默认起名</span>}
            </div>
          )}
          <div class="repo-cols">
            <Column title="本世界" nodes={worldNodes} count={sum(tree.world)} ctx={{ ...base, side: 'world' }} empty={w ? '没有内容' : '先新建或打开世界'} />
            <Column title="资源库" nodes={libNodes} count={sum(libNodes)} ctx={{ ...base, side: 'library' }} empty="没有内容" />
          </div>
          {kind && HUMAN_KINDS.has(kind.id) && w && (
            <div class="row between repo-restyle">
              <span class="hint">{w.small.human ? '改了内容后重新生成才用到' : '还没有生成人文'}</span>
              <button class="small" onClick={openHuman}>
                {w.small.human ? '重新生成…' : '生成人文…'}
              </button>
            </div>
          )}
          {kind && SETTLE_KINDS.has(kind.id) && w && (
            <div class="row between repo-restyle">
              <span class="hint">{w.small.settlementRules ? '改了以后重新生成才放到地图上' : '还没有生成城市'}</span>
              <button class="small" onClick={openSettlements}>
                {w.small.settlementRules ? '重新生成…' : '生成城市…'}
              </button>
            </div>
          )}
          {kind && GOV_KINDS.has(kind.id) && w && (
            <div class="row between repo-restyle">
              <span class="hint">{w.small.human?.countryRules ? '改了内容后重新生成才用到' : '还没有生成国家'}</span>
              <button class="small" onClick={openCountries}>
                {w.small.human?.countryRules ? '重新生成…' : '生成国家…'}
              </button>
            </div>
          )}
          {restyle && (
            <div class="row between repo-restyle">
              <span class="hint">换了默认，已有的省名不变</span>
              <button class="small" title="锁定的、自己选了风格的不动" onClick={() => void exec(restyle, '正在起名…')}>
                重起省名
              </button>
            </div>
          )}
          <div class="repo-foot">{preview.note ? <p class={`small ${preview.note.warn ? 'warn' : ''}`}>{preview.note.text}</p> : <p class="hint">可以撤销</p>}</div>
        </>
      )}
    </div>
  );
}

// 一行里只放说明的第一句（放不下省略），全文在悬停里
export function firstSentence(s: string): string {
  const k = s.indexOf('。');
  return k > 0 ? s.slice(0, k) : s;
}
