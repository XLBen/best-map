import { ChevronDown, ChevronLeft, Ellipsis, Plus, Redo2, Undo2, X } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { packFileName } from '../../../core/packs';
import { library } from '../../library';
import { copyLibrary, createLibrary, deleteLibrary, libEdits } from '../../library-edit';
import { askText, askUser, canRedo, canUndo, download, redo, showToast, undo, world } from '../../state';
import { type Crumb, type PageCtx, type Route, type SourceMenuItem, type SourceRef, WORLD_SOURCE, crumbs, entryOf, sourceKind, sourceMenu, sourceTitle } from './pages';
import { closeLibrary, copyToMine, goBack, goDepth, lastPress, libPanel, livePanel, setSource } from './panel-store';
import { PageHome, WaterHubPage } from './PageHome';
import { PageItem } from './PageItem';
import { PageList } from './PageList';
import { WaterTablePage } from './PageWater';
import { dragView } from './page-drag';
import { pressImport } from './page-import';
import { RegenBar } from './RegenBar';
import { openPackList, packDialog } from './store';
import { tidyWorld } from './tidy';

// 资源库面板（第五十九轮）：左上角一个面板，标题是下拉（本世界 / 内置的库 / 我的库 / + 新建一个库），切换后界面完全一样。
// 层层点进去：首页 → 列表 → 这一项的页面，左上角返回。逻辑都在 pages.ts，这里只画。
// 右上角“导入”打开导入窗口（第六十一轮，ImportDialog.tsx）

// ---------- 标题的下拉 ----------

async function newLibrary(src: SourceRef, ctx: PageCtx) {
  const from = entryOf(src, ctx);
  const r = await askText({
    title: '新建一个库',
    input: '我的库',
    choices: [
      ...(from ? [{ value: 'copy', label: `复制“${from.pack.name}”` }] : []),
      { value: 'empty', label: '空的库', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (r.value === 'cancel' || !r.text.trim()) return;
  const made = r.value === 'copy' && from ? await copyLibrary(from.key, r.text) : await createLibrary(r.text);
  if (made) setSource({ t: 'lib', key: made.key });
}

function SourcePicker({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
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
  const m = sourceMenu(src, ctx);
  const row = (x: SourceMenuItem) => (
    <button
      class={`item ${x.on ? 'on' : ''}`}
      onClick={() => {
        setOpen(false);
        setSource(x.src);
      }}
    >
      <span class="grow ellipsis">{x.name}</span>
    </button>
  );
  return (
    <div class="lp-source" ref={box}>
      <button class={`lp-source-btn ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title="换一个库">
        <b class="ellipsis">{sourceTitle(src, ctx)}</b>
        <ChevronDown />
      </button>
      {open && (
        <div class="lp-source-menu">
          {row(m.world)}
          <h6 class="lp-menu-group">内置的库</h6>
          {m.builtin.map(row)}
          {m.mine.length > 0 && <h6 class="lp-menu-group">我的库</h6>}
          {m.mine.map(row)}
          {m.imported.length > 0 && <h6 class="lp-menu-group">导入的库</h6>}
          {m.imported.map(row)}
          <button
            class="item lp-menu-new"
            onClick={() => {
              setOpen(false);
              void newLibrary(src, ctx);
            }}
          >
            <Plus />
            <span class="grow">新建一个库</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- 右上角 ----------

async function renameLibrary(key: string, name: string) {
  const r = await askText({
    title: '改名',
    input: name,
    choices: [
      { value: 'ok', label: '改名', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (r.value !== 'ok') return;
  const done = libEdits.rename(key, r.text);
  if (!done.ok) showToast(done.error, true);
}

async function removeLibrary(key: string, name: string) {
  const v = await askUser({
    title: `删除“${name}”`,
    text: '用过它的世界不受影响，世界里有自己的一份。这一步不能撤销。',
    choices: [
      { value: 'delete', label: '删除', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'delete') return;
  setSource(WORLD_SOURCE);
  await deleteLibrary(key);
}

function MoreMenu({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
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
  const k = sourceKind(src, ctx);
  const e = entryOf(src, ctx);
  const item = (label: string, title: string, run: () => void) => (
    <button
      class="item"
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
    <div class="lp-more" ref={box}>
      <button class={`icon-btn ${open ? 'open' : ''}`} title="更多" onClick={() => setOpen(!open)}>
        <Ellipsis />
      </button>
      {open && (
        <div class="lp-source-menu right">
          {e && (k === 'builtin' || k === 'imported') && item('复制成我的库', '复制一份来改', () => void copyToMine(src))}
          {e && k === 'mine' && item('改名…', '', () => void renameLibrary(e.key, e.pack.name))}
          {e && item('导出文件', '整个库存成一个文件', () => download(packFileName(e.pack), JSON.stringify(e.pack, null, 2), 'application/json'))}
          {e && k === 'mine' && item('删除这个库…', '用过它的世界不受影响', () => void removeLibrary(e.key, e.pack.name))}
          {k === 'world' && item('从本世界存进资源库…', '挑几样存成一个资源包', () => (packDialog.value = { view: 'export' }))}
          {k === 'world' && item('清理没用到的…', '清掉列表上变淡的内容', () => void tidyWorld())}
          {item('资源包…', '资源库里的包：导出、删除', openPackList)}
        </div>
      )}
    </div>
  );
}

// 撤销、重做：看本世界时是世界的（和顶栏同一个），看我的库时是这个库自己的
function UndoButtons({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  void libEdits.tick.value;
  const k = sourceKind(src, ctx);
  if (k === 'builtin' || k === 'imported' || k === null) return null;
  const lib = src.t === 'lib' ? src.key : null;
  const u = lib ? libEdits.canUndo(lib) : canUndo.value;
  const r = lib ? libEdits.canRedo(lib) : canRedo.value;
  return (
    <>
      <button class="icon-btn" disabled={!u} title={lib ? '撤销（这个库，⌘Z）' : '撤销（⌘Z）'} onClick={() => (lib ? libEdits.undo(lib) : void undo())}>
        <Undo2 />
      </button>
      <button class="icon-btn" disabled={!r} title={lib ? '重做（这个库，⇧⌘Z）' : '重做（⇧⌘Z）'} onClick={() => (lib ? libEdits.redo(lib) : void redo())}>
        <Redo2 />
      </button>
    </>
  );
}

// ---------- 返回与面包屑 ----------

function NavBar({ list }: { list: Crumb[] }) {
  return (
    <div class="lp-nav">
      <button class="lp-back" onClick={goBack} title="返回（Esc）">
        <ChevronLeft />
        <span class="ellipsis">{list[list.length - 2].label}</span>
      </button>
      {list.length > 2 && (
        <span class="lp-crumbs ellipsis" title={list.map((c) => c.label).join(' › ')}>
          {list.slice(0, -2).map((c) => (
            <button class="lp-crumb" onClick={() => c.depth !== null && goDepth(c.depth)}>
              {c.label} ›
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

// 拖卡片时跟着鼠标的小卡片（第六十轮）：写着拖的是什么、松手会怎样
function DragGhost() {
  const d = dragView.value;
  if (!d) return null;
  return (
    <div class={`lp-ghost ${d.ok ? 'ok' : d.refuse ? 'no' : ''}`} style={{ left: d.x + 14, top: d.y + 10 }}>
      <b>{d.label}</b>
      {d.text && <span class="hint">{d.text}</span>}
    </div>
  );
}

// ---------- 一页 ----------

function Page({ route, src, ctx }: { route: Route; src: SourceRef; ctx: PageCtx }) {
  switch (route.p) {
    case 'home':
      return <PageHome src={src} ctx={ctx} />;
    case 'water':
      return <WaterHubPage src={src} ctx={ctx} />;
    case 'table':
      return <WaterTablePage src={src} ctx={ctx} />;
    case 'list':
      return <PageList key={JSON.stringify(route)} route={route} src={src} ctx={ctx} />;
    case 'item':
      return <PageItem key={`${route.kind}|${route.id}`} route={route} src={src} ctx={ctx} />;
  }
}

export function LibPanel() {
  const st = libPanel.value;
  const body = useRef<HTMLDivElement>(null);
  // 每一层滚到哪里（返回时回到原来的地方）
  const scrolls = useRef(new Map<string, number>());
  const key = st ? JSON.stringify(st.stack) : '';
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = scrolls.current.get(key) ?? 0;
  }, [key]);
  if (!st) return null;
  const ctx: PageCtx = { world: world.value, lib: library.value };
  const { source, stack } = livePanel(st, ctx);
  const route = stack[stack.length - 1];
  const list = crumbs(stack, source, ctx);
  return (
    <div class={`lib-panel ${route.p === 'table' ? 'wide' : ''}`} onPointerDownCapture={() => (lastPress.inPanel = true)}>
      <div class="lp-head">
        <SourcePicker src={source} ctx={ctx} />
        <span class="lp-actions">
          <UndoButtons src={source} ctx={ctx} />
          <button class="small lp-import" disabled={source.t === 'world' && !ctx.world} title={source.t === 'world' && !ctx.world ? '先新建或打开世界' : '从别的库、文件挑几项'} onClick={() => void pressImport(source, ctx)}>
            导入
          </button>
          <MoreMenu src={source} ctx={ctx} />
          <button class="icon-btn" onClick={closeLibrary} title="关闭">
            <X />
          </button>
        </span>
      </div>
      {source.t === 'world' && <RegenBar ctx={ctx} />}
      {stack.length > 1 && <NavBar list={list} />}
      <div class="lp-body" ref={body} onScroll={(e) => scrolls.current.set(key, (e.currentTarget as HTMLDivElement).scrollTop)}>
        <Page route={route} src={source} ctx={ctx} />
      </div>
      <DragGhost />
    </div>
  );
}
