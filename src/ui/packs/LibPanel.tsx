import { ChevronDown, ChevronLeft, ChevronRight, Ellipsis, FileUp, LibraryBig, Lock, Map as MapIcon, Plus, X } from 'lucide-preact';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { canApply, packFileName } from '../../../core/packs';
import { panelLibrary } from '../../library';
import { copyLibrary, createLibrary, deleteLibrary, libEdits } from '../../library-edit';
import { askText, askUser, download, showToast, world } from '../../state';
import { kindOf } from '../../../core/content/registry';
import { type Crumb, type PageCtx, type Route, type SourceMenuItem, type SourceRef, WORLD_SOURCE, crumbs, entryOf, itemOf, sourceKind, sourceMenu, sourceTitle } from './pages';
import { closeLibrary, copyToMine, finishPicking, goBack, goDepth, lastPress, libPanel, livePanel, openBasket, openLibraryAt, pickThis, pickingIn, setSource, startPicking } from './panel-store';
import { ADD_TO_WORLD, BACK_TO_WORLD, COPY_LIBRARY, COPY_LIBRARY_TIP, EXPORT_FILE, KEEP_FILE, KEEP_FILE_TIP, NEW_LIBRARY, OPEN_IN_WORLD, OPEN_IN_WORLD_TIP, PICK_DONE, PICK_ENTER, PICK_ENTER_TIP, PICK_HELP, READ_FILE, READ_FILE_TIP, SAVE_ALL_TIP, SAVE_TO_MINE, SOURCE_MORE, SOURCE_MORE_TIP, SOURCE_TIP, TIDY, TIDY_TIP, pickHeadAfter, pickHeadBefore, pickPending } from './copy';
import { showAllSources } from './lib-prefs';
import { saveAllToMine } from './save-mine-run';
import { type SourceGroup, editingLine, editingText, sourceMenuView } from './source-view';
import { addNow } from './pick-add';
import { shownPick } from './pick-view';
import { PageGen } from './PageGen';
import { EcologyHubPage, PageHome } from './PageHome';
import { PageItem } from './PageItem';
import { PageList } from './PageList';
import { WaterTablePage } from './PageEcology';
import { dragView } from './page-drag';
import { LibOther } from './LibOther';
import { LibSide } from './LibSide';
import { closeFile, installFile, openFile } from './lib-file';
import { panelKeys } from './lib-keys';
import { rememberFrom } from './pick-other';
import { pickCount } from './pick-store';
import { RegenBar as RegenBarRaw } from './RegenBar';
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

// 第七十九轮：顶上一行（标题的下拉、撤销、更多、文件、重新生成）都是 memo：面板里别处变了（勾选、翻页、拖滑块）不重画它们，
// ctx 只在世界、资源库换了时是新的（见 LibPanel）
const SourcePicker = memo(function SourcePicker({ src, ctx, picking, canAdd }: { src: SourceRef; ctx: PageCtx; picking: boolean; canAdd: boolean }) {
  const [open, setOpen] = useState(false);
  // “更多”：平时收着（第九十二轮）；正在看的那一份在里面时一打开就展开着
  const [more, setMore] = useState<boolean | null>(null);
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
  const v = sourceMenuView(sourceMenu(src, ctx), { all: showAllSources(), picking, canPick: canAdd, hasWorld: !!ctx.world });
  const moreOpen = more ?? v.moreOpen;
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
  const group = (g: SourceGroup) => (
    <>
      <h6 class="lp-menu-group">{g.title}</h6>
      {g.items.map(row)}
    </>
  );
  const extras = (
    <>
      <button
        class="item lp-menu-new"
        onClick={() => {
          setOpen(false);
          void newLibrary(src, ctx);
        }}
      >
        <Plus />
        <span class="grow">{NEW_LIBRARY}</span>
      </button>
      <button class="item" title={READ_FILE_TIP} onClick={() => file.current?.click()}>
        <FileUp />
        <span class="grow">{READ_FILE}</span>
      </button>
    </>
  );
  return (
    <div class="lp-source" ref={box}>
      <button class={`lp-source-btn ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title={SOURCE_TIP}>
        <b class="ellipsis">{sourceTitle(src, ctx)}</b>
        <ChevronDown />
      </button>
      {open && (
        <div class="lp-source-menu">
          {v.top.map(row)}
          {v.pickEntry && (
            <button
              class="item"
              title={PICK_ENTER_TIP}
              onClick={() => {
                setOpen(false);
                startPicking();
              }}
            >
              <Plus />
              <span class="grow">{PICK_ENTER}</span>
            </button>
          )}
          {v.groups.map(group)}
          {v.more ? (
            <>
              <button class={`item lp-menu-more ${moreOpen ? 'open' : ''}`} title={SOURCE_MORE_TIP} aria-expanded={moreOpen} onClick={() => setMore(!moreOpen)}>
                <ChevronRight />
                <span class="grow">{SOURCE_MORE}</span>
              </button>
              {moreOpen && v.more.map(group)}
              {moreOpen && extras}
            </>
          ) : (
            extras
          )}
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
});

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

const MoreMenu = memo(function MoreMenu({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
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
      <button class={`icon-btn ${open ? 'open' : ''}`} title="更多" aria-label="更多" onClick={() => setOpen(!open)}>
        <Ellipsis />
      </button>
      {open && (
        <div class="lp-source-menu right">
          {e && (k === 'builtin' || k === 'imported') && item(COPY_LIBRARY, COPY_LIBRARY_TIP, () => void copyToMine(src))}
          {e && k === 'mine' && item('改名…', '', () => void renameLibrary(e.key, e.pack.name))}
          {e && k === 'file' && item(KEEP_FILE, KEEP_FILE_TIP, () => installFile(e.key))}
          {e &&
            k === 'file' &&
            item('不看这个文件', '从下拉里去掉，勾的也去掉', () => {
              setSource(ctx.world ? WORLD_SOURCE : { t: 'lib', key: ctx.lib[0].key });
              closeFile(e.key);
            })}
          {e && k !== 'file' && item(EXPORT_FILE, '整个库存成一个文件', () => download(packFileName(e.pack), JSON.stringify(e.pack, null, 2), 'application/json'))}
          {e && k === 'mine' && item('删除这个库…', '用过它的世界不受影响', () => void removeLibrary(e.key, e.pack.name))}
          {/* 第九十二轮：和一项的页面上的“存到我的库”是同一个动作、同一个去向（save-mine-run.ts） */}
          {k === 'world' && item(`${SAVE_TO_MINE}…`, SAVE_ALL_TIP, () => void saveAllToMine(ctx))}
          {k === 'world' && item(`${EXPORT_FILE}…`, '挑几样存成一个文件', () => (packDialog.value = { view: 'export' }))}
          {k === 'world' && item(`${TIDY}…`, TIDY_TIP, () => void tidyWorld())}
          {item('管理库…', '加进来的库、我的库：导出、删除', openPackList)}
        </div>
      )}
    </div>
  );
});

// 读进来的文件：顶上一条“加进资源库…”
const FileBar = memo(function FileBar({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const e = entryOf(src, ctx);
  if (!e?.file) return null;
  return (
    <div class="lp-filebar">
      <span class="hint grow ellipsis" title={e.file}>
        文件：{e.file}，没加进资源库
      </span>
      <button class="small" title={KEEP_FILE_TIP} onClick={() => installFile(e.key)}>
        {KEEP_FILE}
      </button>
    </div>
  );
});

// 面板顶上一直在的一句（第九十二轮，source-view.ts）：现在改的是哪一份——“改的是：这张地图”“改的是：我的库“X”（新地图会用）”“只能看：X”，
// 三种颜色、三种图标。挑选时写挑了加到哪一份。看的不是这张地图时右边一个按钮：只读的库里一项的页面上“在这张地图里打开 / 添加到这张地图…”，别的“回到这张地图”
const EDITING_ICON = { world: MapIcon, mine: LibraryBig, readonly: Lock };
const EditingBar = memo(function EditingBar({ src, ctx, route, pickTo }: { src: SourceRef; ctx: PageCtx; route: Route; pickTo: SourceRef | null }) {
  const line = editingLine(src, ctx, pickTo);
  if (!line) return null;
  const I = EDITING_ICON[line.tone];
  const kind = route.p === 'item' ? kindOf(route.kind) : undefined;
  const readonly = line.tone === 'readonly';
  const inWorld = route.p === 'item' && kind && itemOf(WORLD_SOURCE, kind, route.id, ctx) !== undefined;
  const away = !pickTo && src.t !== 'world' && !!ctx.world;
  return (
    <div class={`lp-editing ${line.tone}`} title={editingText(line)}>
      <I />
      <span class="grow ellipsis">
        {line.head}：<b>{line.name}</b>
        {line.note && `（${line.note}）`}
      </span>
      {away &&
        (readonly && route.p === 'item' && kind ? (
          inWorld ? (
            <button class="small primary" title={OPEN_IN_WORLD_TIP} onClick={() => openLibraryAt(WORLD_SOURCE, [{ p: 'home' }, { p: 'item', kind: route.kind, id: route.id }])}>
              {OPEN_IN_WORLD}
            </button>
          ) : canApply(kind) ? (
            <button class="small primary" onClick={() => pickThis(route)}>
              {ADD_TO_WORLD}
            </button>
          ) : null
        ) : (
          <button class="small" onClick={() => setSource(WORLD_SOURCE)}>
            {BACK_TO_WORLD}
          </button>
        ))}
    </div>
  );
});

// 挑选时的“完成”：勾了还没添加的先问一句
async function finishWithPicks(src: SourceRef, ctx: PageCtx) {
  const v = shownPick(src, ctx);
  const n = v?.preview.count ?? 0;
  if (v && n > 0) {
    const r = await askUser({
      title: pickPending(n),
      text: '勾的会记着，下次挑选时还在。',
      choices: [
        { value: 'add', label: `添加 ${n} 项`, primary: true },
        { value: 'later', label: '先不加' },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (r !== 'add' && r !== 'later') return;
    if (r === 'add') await addNow(v, ctx, false);
  }
  finishPicking();
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
    case 'gen':
      return <PageGen ctx={ctx} />;
    case 'list':
      return <PageList key={JSON.stringify(route)} route={route} src={src} ctx={ctx} />;
    case 'item':
      return <PageItem key={`${route.kind}|${route.id}`} route={route} src={src} ctx={ctx} />;
  }
}

const RegenBar = memo(RegenBarRaw);

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
  // 第七十九轮：世界、资源库没换时是同一个 ctx（memo 的部件不重画）
  const w = world.value;
  const lib = panelLibrary.value;
  const ctx: PageCtx = useMemo(() => ({ world: w, lib }), [w, lib]);
  const live = st && livePanel(st, ctx);
  const seen = live?.source.t === 'lib' ? live.source.key : '';
  // “从库里添加…”下次切到这个库（我的库、读进来的文件不算）
  useEffect(() => {
    const e = seen ? entryOf({ t: 'lib', key: seen }, ctx) : undefined;
    if (e && !e.file && !e.mine && pickingIn({ t: 'lib', key: seen }, ctx)) rememberFrom(seen);
  }, [seen]);
  // 挑选时顶上写挑了加到哪一份：清单上“加到”选的那一份（没算出来时是进入挑选前看的那一份）
  const pickDest = live?.pick ? (shownPick(live.source, ctx)?.dest ?? null) : null;
  const back = live?.pick?.back.source;
  const destKey = !live?.pick ? null : pickDest ? (pickDest === 'world' ? 'world' : pickDest.lib) : back?.t === 'lib' ? back.key : 'world';
  const pickTo = useMemo<SourceRef | null>(() => (destKey === null ? null : destKey === 'world' ? WORLD_SOURCE : { t: 'lib', key: destKey }), [destKey]);
  if (!st || !live) return null;
  const { stack } = live;
  const src = live.source;
  const route = stack[stack.length - 1];
  const list = crumbs(stack, src, ctx);
  const pick = !!live.pick;
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
        <div class={`lp-head ${pick ? 'picking' : ''}`}>
          <span class="lp-title">
            {pick && <span class="lp-pick-word">{pickHeadBefore}</span>}
            <SourcePicker src={src} ctx={ctx} picking={pick} canAdd={canAdd} />
            {pick && <span class="lp-pick-word">{pickHeadAfter}</span>}
            {count > 0 && <span class="lp-picked">已勾 {count}</span>}
          </span>
          <span class="lp-actions">
            {pick ? (
              <button class="small primary" onClick={() => void finishWithPicks(src, ctx)} title="Esc">
                {PICK_DONE}
              </button>
            ) : (
              canAdd && (
                <button class="small lp-import" title={PICK_ENTER_TIP} onClick={() => startPicking()}>
                  {PICK_ENTER}
                </button>
              )
            )}
            {!pick && <MoreMenu src={src} ctx={ctx} />}
            <button class="icon-btn" onClick={closeLibrary} title="关闭" aria-label="关闭">
              <X />
            </button>
          </span>
        </div>
        <FileBar src={src} ctx={ctx} />
        <EditingBar src={src} ctx={ctx} route={route} pickTo={pickTo} />
        {pick && <p class="hint lp-pick-help">{PICK_HELP}</p>}
        {stack.length > 1 && <NavBar list={list} />}
        <div class="lp-body" ref={body} onScroll={(e) => scrolls.current.set(key, (e.currentTarget as HTMLDivElement).scrollTop)}>
          <Page route={route} src={src} ctx={ctx} />
        </div>
        {src.t === 'world' && <RegenBar ctx={ctx} />}
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
