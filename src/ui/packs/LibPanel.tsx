import { ChevronDown, ChevronLeft, ChevronRight, Ellipsis, FileUp, Plus, Redo2, Undo2, X } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { packFileName } from '../../../core/packs';
import { panelLibrary } from '../../library';
import { copyLibrary, createLibrary, deleteLibrary, libEdits } from '../../library-edit';
import { askText, askUser, canRedo, canUndo, download, redo, showToast, undo, world } from '../../state';
import { type Crumb, type PageCtx, type Route, type SourceMenuItem, type SourceRef, WORLD_SOURCE, crumbs, entryOf, sourceKind, sourceMenu, sourceTitle } from './pages';
import { closeLibrary, copyToMine, goBack, goDepth, lastPress, libPanel, livePanel, openBasket, pickingIn, setSource } from './panel-store';
import { EcologyHubPage, PageHome } from './PageHome';
import { PageItem } from './PageItem';
import { PageList } from './PageList';
import { WaterTablePage } from './PageEcology';
import { dragView } from './page-drag';
import { LibOther } from './LibOther';
import { LibSide } from './LibSide';
import { closeFile, installFile, openFile } from './lib-file';
import { panelKeys } from './lib-keys';
import { defaultFrom, rememberFrom } from './pick-other';
import { pickCount, setPickDest } from './pick-store';
import { RegenBar } from './RegenBar';
import { openPackList, packDialog } from './store';
import { tidyWorld } from './tidy';

// 资源库面板（第五十九轮）：左上角一个面板，标题是下拉（本世界 / 内置的库 / 我的库 / 读进来的文件 / + 新建一个库），切换后界面完全一样。
// 层层点进去：首页 → 列表 → 这一项的页面，左上角返回。逻辑都在 pages.ts，这里只画。
// 第六十七轮：看库就是添加（没有导入窗口了）。有地方加时库的每一行有勾，勾了东西或点了一项时右栏（LibSide.tsx）滑出来，
// 面板变宽成两栏；右上角“从库里添加…”切到上次用的库。“导入”只留给读文件（标题下拉的“读文件…”）。
// 第六十八轮：列表、上级页面上的“从别的库加”在右栏打开 LibOther.tsx（能多选），开着时右栏是它

// 窗口窄（约 900 px 以下）时右栏放不下：盖在左栏上
const NARROW = '(max-width: 900px)';
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

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
  const file = useRef<HTMLInputElement>(null);
  const m = sourceMenu(src, ctx);
  const row = (x: SourceMenuItem) => {
    const n = x.src.t === 'lib' ? pickCount(x.src.key) : 0;
    return (
      <button
        class={`item ${x.on ? 'on' : ''}`}
        onClick={() => {
          setOpen(false);
          setSource(x.src);
        }}
      >
        <span class="grow ellipsis">{x.name}</span>
        {n > 0 && <span class="lp-picked">已勾 {n}</span>}
      </button>
    );
  };
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
          {m.files.length > 0 && <h6 class="lp-menu-group">读进来的文件</h6>}
          {m.files.map(row)}
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
          <button class="item" title="读资源包文件，不运行脚本" onClick={() => file.current?.click()}>
            <FileUp />
            <span class="grow">读文件…</span>
          </button>
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(ev) => {
          const f = (ev.target as HTMLInputElement).files?.[0];
          setOpen(false);
          if (f) void openFile(f);
          (ev.target as HTMLInputElement).value = '';
        }}
      />
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
          {e && k === 'file' && item('装进资源库…', '查过脚本后存进资源库', () => installFile(e.key))}
          {e &&
            k === 'file' &&
            item('不看这个文件', '从下拉里去掉，勾的也去掉', () => {
              setSource(ctx.world ? WORLD_SOURCE : { t: 'lib', key: ctx.lib[0].key });
              closeFile(e.key);
            })}
          {e && k !== 'file' && item('导出文件', '整个库存成一个文件', () => download(packFileName(e.pack), JSON.stringify(e.pack, null, 2), 'application/json'))}
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
  if (k === 'builtin' || k === 'imported' || k === 'file' || k === null) return null;
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

// “从库里添加…”（原来右上角的“导入”，第六十七轮）：加到正在看的本世界或我的库，切到上次用的库
function startAdding(src: SourceRef, ctx: PageCtx) {
  setPickDest(src.t === 'lib' ? { lib: src.key } : 'world');
  const from = defaultFrom(src, ctx);
  if (from) setSource({ t: 'lib', key: from });
}

// 读进来的文件：顶上一条“装进资源库…”
function FileBar({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const e = entryOf(src, ctx);
  if (!e?.file) return null;
  return (
    <div class="lp-filebar">
      <span class="hint grow ellipsis" title={e.file}>
        文件：{e.file}，没装进资源库
      </span>
      <button class="small" onClick={() => installFile(e.key)}>
        装进资源库…
      </button>
    </div>
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
    case 'ecology':
      return <EcologyHubPage src={src} ctx={ctx} />;
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
  const narrow = useNarrow();
  // 每一层滚到哪里（返回时回到原来的地方）
  const scrolls = useRef(new Map<string, number>());
  const key = st ? JSON.stringify(st.stack) : '';
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = scrolls.current.get(key) ?? 0;
  }, [key]);
  const ctx: PageCtx = { world: world.value, lib: panelLibrary.value };
  const live = st && livePanel(st, ctx);
  const seen = live?.source.t === 'lib' ? live.source.key : '';
  // “从库里添加…”下次切到这个库（我的库、读进来的文件不算）
  useEffect(() => {
    const e = seen ? entryOf({ t: 'lib', key: seen }, ctx) : undefined;
    if (e && !e.file && !e.mine && pickingIn({ t: 'lib', key: seen }, ctx)) rememberFrom(seen);
  }, [seen]);
  if (!st || !live) return null;
  const { stack } = live;
  const src = live.source;
  const route = stack[stack.length - 1];
  const list = crumbs(stack, src, ctx);
  const picking = pickingIn(src, ctx);
  const count = picking ? pickCount(src.key) : 0;
  const side = live.side?.p === 'item' ? live.side : null;
  // “从别的库加”开着时右栏是它（第六十八轮；底下点开的那一项收起它后还在）
  const other = live.other ?? null;
  // 两栏：勾了东西或右栏开着；窄窗口里点了一项、点了清单、开了“从别的库加”才盖上
  const wide = !!other || (picking && (!!side || count > 0));
  const over = narrow && (!!other || (picking && (!!side || !!live.basket)));
  const two = wide && !narrow;
  const k = sourceKind(src, ctx);
  const canAdd = (src.t === 'world' && !!ctx.world) || k === 'mine';
  return (
    <div
      class={`lib-panel ${route.p === 'table' ? 'wide' : ''} ${two ? 'two' : ''} ${over ? 'over' : ''}`}
      onPointerDownCapture={() => (lastPress.inPanel = true)}
      onKeyDown={(e) => panelKeys(e, body.current, src, ctx, !!side || !!live.basket || !!other)}
    >
      <div class="lp-main">
        <div class="lp-head">
          <span class="lp-title">
            <SourcePicker src={src} ctx={ctx} />
            {count > 0 && <span class="lp-picked">已勾 {count}</span>}
          </span>
          <span class="lp-actions">
            <UndoButtons src={src} ctx={ctx} />
            {canAdd && (
              <button class="small lp-import" title={src.t === 'world' ? '从别的库挑几项加到本世界' : '从别的库挑几项加到这个库'} onClick={() => startAdding(src, ctx)}>
                从库里添加…
              </button>
            )}
            <MoreMenu src={src} ctx={ctx} />
            <button class="icon-btn" onClick={closeLibrary} title="关闭">
              <X />
            </button>
          </span>
        </div>
        <FileBar src={src} ctx={ctx} />
        {src.t === 'world' && <RegenBar ctx={ctx} />}
        {stack.length > 1 && <NavBar list={list} />}
        <div class="lp-body" ref={body} onScroll={(e) => scrolls.current.set(key, (e.currentTarget as HTMLDivElement).scrollTop)}>
          <Page route={route} src={src} ctx={ctx} />
        </div>
        {narrow && count > 0 && !over && (
          <button class="lp-basket-bar" onClick={openBasket}>
            <span class="grow">已勾 {count} 项</span>
            <span class="hint">清单</span>
            <ChevronRight />
          </button>
        )}
      </div>
      {(two || over) && (other ? <LibOther src={src} o={other} ctx={ctx} over={over} /> : <LibSide src={src} side={side} ctx={ctx} over={over} />)}
      <DragGhost />
    </div>
  );
}
