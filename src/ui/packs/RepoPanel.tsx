import { Ellipsis, Plus, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { kindOf } from '../../../core/content/registry';
import { PACK_MAX_CHARS, readPack, sameItem } from '../../../core/packs';
import type { World } from '../../../core/world';
import { library } from '../../library';
import { world } from '../../state';
import { isDirty, startEdit } from './edit';
import { type Line, findRow, treeLines } from './lines';
import { loadRepoPrefs, saveRepoPrefs } from './prefs';
import { type TreeNode, filterTree, packTree, repoKinds } from './repo';
import { canNew, newItem } from './repo-actions';
import { RepoSide } from './RepoDetail';
import { type ListCtx, RepoList } from './RepoList';
import { usePreview } from './RepoPreview';
import { closeRepo, fileLabel, openPackImport, openPackList, packDialog, patchRepo, repo } from './store';
import { missingCount } from './styles';
import { tidyWorld } from './tidy';

// 资源库（第二十八轮以前叫仓库）：顶栏最左边的“资源库”（第四十五轮；世界菜单里也有）打开，从左上角展开，浮在地图上。
// 第二十九轮起内容都按资源包分组：本世界的每一项按记着的来源（small.origin）归到资源库的包（大包 ▸ 小包），
// 本世界做的放在最后的“离群”；资源库是内置的、我的、装上的资源包，各是一棵树。
// 第四十五轮：左栏是这两段（各自能收起）摊成的一长列，只画看得见的行；右栏是选中的一项的详情和编辑器（不再盖住整个面板）。
//   顶上：种类（全部或一种）、搜索、新建、“⋯”（从文件导入、从本世界存进资源库、整理本世界、资源包）。
//   展开的包、收起的段、上次看的种类记在浏览器里（prefs.ts），存不了时照默认的样子。
// 鼠标停在“添加”“移出”上，地图上先画出之后的样子（RepoPreview.ts）。窄屏时左右两栏上下排

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
          {item('清理没用到的…', '清掉生成后没用到的内容', () => void tidyWorld(), !w)}
          {item('资源包…', '资源库里的包：导出、删除', openPackList)}
        </div>
      )}
    </div>
  );
}

// 种类的下拉框
function KindSelect({ value }: { value: string }) {
  return (
    <select class="repo-kind-select" value={value} title="只看一种" onChange={(e) => patchRepo({ kind: (e.target as HTMLSelectElement).value, edit: undefined, sel: undefined })}>
      <option value="all">全部</option>
      {repoKinds().map((k) => (
        <option value={k.id}>{k.label}</option>
      ))}
    </select>
  );
}

// ---------- 展开、收起（记在浏览器里） ----------

function useOpenState() {
  const [open, setOpen] = useState<Set<string>>(() => new Set(loadRepoPrefs().open));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadRepoPrefs().collapsed));
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      saveRepoPrefs({ open: [...next] });
      return next;
    });
  const collapse = (side: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (!next.delete(side)) next.add(side);
      saveRepoPrefs({ collapsed: [...next] });
      return next;
    });
  // 只看一个包时整个展开（不记）
  const expand = (keys: readonly string[]) => setOpen((s) => new Set([...s, ...keys]));
  return { open, collapsed, toggle, collapse, expand };
}

// ---------- 整个资源库 ----------

export function RepoPanel() {
  const st = repo.value;
  const w = world.value;
  const lib = library.value;
  const preview = usePreview(st ? w : null);
  const kindId = st?.kind && (st.kind === 'all' || kindOf(st.kind)) ? st.kind : 'all';
  const kind = kindId === 'all' ? null : (kindOf(kindId) ?? null);
  const tree = useMemo(() => (st ? packTree(w, lib, kindId) : { world: [], library: [] }), [w, lib, kindId, !!st]);
  const { open, collapsed, toggle, collapse, expand } = useOpenState();
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
    expand(keys);
  }, [st?.entry, kindId, !!st?.entry && tree.library.some((n) => n.entry === st.entry)]);
  const query = st?.query ?? '';
  const libNodes = useMemo(() => (st ? filterTree(st.entry ? tree.library.filter((n) => n.entry === st.entry) : tree.library, query, st.filter === 'off') : []), [tree, query, st?.entry, st?.filter]);
  const worldNodes = useMemo(() => filterTree(tree.world, query), [tree, query]);
  const searching = !!query.trim();
  const sum = (list: readonly TreeNode[]) => list.reduce((a, n) => a + n.count, 0);
  const lines: Line[] = useMemo(
    () =>
      treeLines(
        [
          { side: 'world', title: '本世界', nodes: worldNodes, count: sum(tree.world), empty: w ? '没有内容' : '先新建或打开世界' },
          { side: 'library', title: '资源库', nodes: libNodes, count: sum(libNodes), empty: '没有内容' },
        ],
        open,
        collapsed,
        searching,
      ),
    [worldNodes, libNodes, open, collapsed, searching, !!w],
  );
  // 选中的一行（换了世界、资源库后按同一个键再找；找不到时没有选中）
  const selRow = st?.sel ? (findRow(tree.world, st.sel) ?? findRow(tree.library, st.sel) ?? null) : null;
  // 选中的一项在世界里变了（撤销、重做、别处改了）而编辑器里没改过：编辑器跟着换成新的样子
  useEffect(() => {
    if (!st || !selRow) return;
    const e = st.edit;
    if (e && e.how !== 'edit') return;
    if (e && e.row === selRow.key && isDirty(e)) return;
    const fresh = startEdit(selRow, w);
    if (!fresh) {
      if (e) patchRepo({ edit: undefined });
      return;
    }
    if (!e || e.row !== selRow.key || e.worldId !== fresh.worldId || !sameItem(fresh.item, e.base)) patchRepo({ edit: fresh });
  }, [selRow?.key, selRow?.item, selRow?.status.on, w]);
  if (!st) return null;
  const editKind = st.edit ? (kindOf(st.edit.kind ?? kindId) ?? null) : null;
  const entryName = st.entry ? lib.find((e) => e.key === st.entry)?.pack.name : undefined;
  const styleView = !kind || kind.id === 'nameStyle';
  const missing = styleView && w ? missingCount(w.small) : 0;
  const ctx: ListCtx = { w, allKinds: !kind, sel: st.sel ?? null, toggle, collapse, onHover: preview.setHover, onRun: preview.settle };
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
      <div class="repo-main">
        <section class="repo-list">
          <RepoList lines={lines} ctx={ctx} reveal={st.sel} />
        </section>
        <section class="repo-side">
          <RepoSide row={selRow} edit={st.edit} editKind={editKind} kind={kind} w={w} onHover={preview.setHover} onRun={preview.settle} />
        </section>
      </div>
      <div class="repo-foot">{preview.note ? <p class={`small ${preview.note.warn ? 'warn' : ''}`}>{preview.note.text}</p> : <p class="hint">可以撤销</p>}</div>
    </div>
  );
}

export { openNewItem, openRepoKind } from './repo-actions';

// 一行里只放说明的第一句（放不下省略），全文在悬停里
export function firstSentence(s: string): string {
  const k = s.indexOf('。');
  return k > 0 ? s.slice(0, k) : s;
}
