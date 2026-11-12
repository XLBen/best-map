import { LucideProvider } from 'lucide-preact';
import type { ComponentType } from 'preact';
import { useEffect } from 'preact/hooks';
import { settingsFor } from '../../core/presets';
import {
  type PanelId,
  type TypePanelId,
  busy,
  cursorHint,
  helpOpen,
  loadReference,
  newWorld,
  openPanel,
  resumeLast,
  sheet,
  showToast,
  uiHidden,
  wizardOpen,
  world,
} from '../state';
import { SmokeBomb } from '../smoke-hooks';
import { STOP_TEXT } from './copy';
import { BusyLine } from './shell/BusyLine';
import { CATEGORY_DEFS } from './defs/tools';
import { Help } from './Help';
import { MapView } from './MapView';
import { BackupsDialog } from './maps/BackupsDialog';
import { backupsDialog } from './maps/backups';
import { VersionsDialog } from './maps/VersionsDialog';
import { versionsDialog } from './maps/versions';
import { MapsDialog } from './maps/MapsDialog';
import { mapsDialog } from './maps/store';
import { PackDialog } from './packs/PackDialog';
import { packDialog } from './packs/store';
import { LibPanel } from './packs/LibPanel';
import { closeLibrary, libPanel, libWide } from './packs/panel-store';
import { MorePanel, WorldMenu } from './panels/ActionsPanel';
import { AdjustPanel } from './panels/AdjustPanel';
import { LayersPanel } from './panels/LayersPanel';
import { CategoryMore } from './panels/ToolLibrary';
import { RiverMore } from './panels/rivers';
import { ProvinceMore } from './provincePanel';
import { LakeTypeMenu, NewLakeTypeMenu } from './panels/lakes';
import { IslandTypeMenu } from './panels/islandTypes';
import { NewRiverTypeMenu, RiverTypeMenu } from './panels/riverTypes';
import { FeatureStyleMenu } from './panels/names';
import { ClassMenu, ResourceMenu } from './panels/human';
import { CultureMenu, PopTupleMenu, ValueMenu } from './panels/culture';
import { TerritoryMenu } from './panels/countries';
import { LandmarkMenu, PointMenu, RankMenu } from './panels/settlements';
import { MapKindMenu } from './shell/MapKind';
import { MapLegend } from './shell/MapLegend';
import { ContextBar } from './shell/ContextBar';
import { HereCard } from './shell/HereCard';
import { onKeyDown, onMouseDownCapture, onPointerDownCapture } from './shell/keys';
import { AskDialog } from './shell/Ask';
import { onEscapeCapture } from './shell/escape';
import { GlNote } from './shell/GlNote';
import { Guard } from './shell/Guard';
import { MishapBanner } from './shell/MishapBanner';
import { Notice } from './shell/Notice';
import { Popover } from './shell/Popover';
import { FitButton, RulerButton } from './shell/Ruler';
import { NarrowNote } from './shell/NarrowNote';
import { fingerOnMap, touchUi } from './touch-ui';
import { TOUCH_TEXT } from './copy';
import { BackupBanner } from './shell/BackupBanner';
import { FileBanner, SaveBanner } from './shell/SaveBanner';
import { ScriptBanner } from './shell/ScriptBanner';
import { SkippedBanner } from './shell/SkippedBanner';
import { Sheet } from './shell/Sheet';
import { TopBar } from './shell/TopBar';
import { newWorldContentCommands } from '../../core/packs/import';
import { Wizard } from './Wizard';
// 工具表里按名字引用的部件、每个工具做什么（放在最后：上面已经引用过的面板先后照旧）
import './register-all';

// 整体：地图铺满全屏，界面浮在上面——顶栏、底部工具条、顶部提示条、右下角“这里”

// 选“哪一种”的六个列表：同一个 TypePicker，只是种类表不一样
const TYPE_PANELS: Record<TypePanelId, { title: string; menu: ComponentType }> = {
  rivertype: { title: '河的种类', menu: RiverTypeMenu },
  newrivertype: { title: '新河的种类', menu: NewRiverTypeMenu },
  laketype: { title: '湖的种类', menu: LakeTypeMenu },
  newlaketype: { title: '新湖的种类', menu: NewLakeTypeMenu },
  islandtype: { title: '岛的种类', menu: () => <IslandTypeMenu which="island" /> },
  chaintype: { title: '岛链的种类', menu: () => <IslandTypeMenu which="chain" /> },
  featurestyle: { title: '地名风格', menu: FeatureStyleMenu },
  classpick: { title: '地形类别', menu: ClassMenu },
  resourcepick: { title: '资源', menu: ResourceMenu },
  culturepick: { title: '文化', menu: CultureMenu },
  poppick: { title: '人口群体', menu: PopTupleMenu },
  valuepick: { title: '取值', menu: ValueMenu },
  countrypick: { title: '领土', menu: TerritoryMenu },
  cityrank: { title: '城市等级', menu: RankMenu },
  landmarkpick: { title: '地标的种类', menu: LandmarkMenu },
  pointpick: { title: '点的种类', menu: PointMenu },
};

function PanelHost({ id }: { id: PanelId }) {
  switch (id) {
    case 'world':
      return (
        <Popover id={id} title="世界" width={360}>
          <WorldMenu />
        </Popover>
      );
    case 'more':
      return (
        <Popover id={id} title="更多" width={340}>
          <MorePanel />
        </Popover>
      );
    case 'adjust':
      return (
        <Popover id={id} title="调整" width={360}>
          <AdjustPanel />
        </Popover>
      );
    case 'layers':
      return (
        <Popover id={id} title="图层" width={320}>
          <LayersPanel />
        </Popover>
      );
    case 'mapkind':
      return (
        <Popover id={id} title="地图模式" width={240}>
          <MapKindMenu />
        </Popover>
      );
    case 'river':
      return (
        <Popover id={id} title="河" width={320}>
          <RiverMore />
        </Popover>
      );
    case 'province':
      return (
        <Popover id={id} title="省份" width={300}>
          <ProvinceMore />
        </Popover>
      );
    default: {
      if (id in TYPE_PANELS) {
        const { title, menu: Menu } = TYPE_PANELS[id as TypePanelId];
        return (
          <Popover id={id} title={title} width={280}>
            <Menu />
          </Popover>
        );
      }
      // 底部工具条末尾的“⋯”：这一类的设置
      const c = id.slice(4) as keyof typeof CATEGORY_DEFS;
      return (
        <Popover id={id} title={`${CATEGORY_DEFS[c].label}设置`} width={380}>
          <CategoryMore c={c} />
        </Popover>
      );
    }
  }
}

function CursorHint() {
  const h = cursorHint.value;
  if (!h || openPanel.value || uiHidden.value) return null;
  // 鼠标在右半边时，说明放在鼠标左边，免得被挤窄
  const cw = window.innerWidth;
  const pos = h.x > cw * 0.55 ? { right: `${Math.max(4, cw - h.x + 12)}px` } : { left: `${h.x + 16}px` };
  // 第一百轮：手指按着时写在手指上面（下面的会被手指挡住）
  const top = fingerOnMap.value ? Math.max(4, h.y - 72) : h.y + 20;
  return (
    <div class={`cursor-hint ${h.warn ? 'warn' : h.caution ? 'caution' : ''}`} style={{ ...pos, top: `${top}px` }}>
      {h.text}
    </div>
  );
}

const SEEN_HELP = 'map2.seenHelp';

export function App() {
  useEffect(() => {
    if (location.hash === '#demo') {
      void newWorld(settingsFor('region', 'tropical', 40000), [
        ...newWorldContentCommands(),
        { op: 'set_worldgen', params: { seed: 3, type: 'archipelago' }, reset: true },
        { op: 'generate_provinces', seed: 3 },
      ]);
    } else {
      // 回来接着做：直接打开上次的世界（上次是安全模式就照样用安全模式；带没信任过的脚本时先问）；
      // 没有、取消了再弹向导。第九十四轮：没能打开时 resumeLast 先停在一个问话上（再试一次、安全模式、导出文件、新建），
      // 选了新建才到这里；那一份在被新世界的自动保存盖掉之前挪进“留着的旧世界”
      void resumeLast().then((ok) => {
        if (ok) showToast('已打开上次的世界');
        else wizardOpen.value = true;
      });
    }
    void loadReference();
    window.addEventListener('keydown', onKeyDown);
    // Esc 的捕获阶段（问话、拖卡片、脚本框的“变量和例子”：比输入框、面板自己的键盘先收到，见 shell/escape.ts）
    window.addEventListener('keydown', onEscapeCapture, true);
    window.addEventListener('mousedown', onMouseDownCapture, true);
    window.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onEscapeCapture, true);
      window.removeEventListener('mousedown', onMouseDownCapture, true);
      window.removeEventListener('pointerdown', onPointerDownCapture, true);
    };
  }, []);

  // 第一次用：建好第一个世界后打开一次帮助
  useEffect(() => {
    if (!world.value || wizardOpen.value) return;
    try {
      if (localStorage.getItem(SEEN_HELP)) return;
      localStorage.setItem(SEEN_HELP, '1');
    } catch {
      return;
    }
    helpOpen.value = true;
  }, [world.value !== null, wizardOpen.value]);

  const w = world.value;
  const hidden = uiHidden.value;
  // 图标一种大小、一种粗细（顶栏的大一号，在 TopBar 里写）
  return (
    <LucideProvider size={16} strokeWidth={1.8}>
      <div class={`app ${sheet.value ? 'with-sheet' : ''} ${libWide.value ? 'lib-wide' : libPanel.value ? 'lib-open' : ''}${touchUi() ? ' touch-ui' : ''}`}>
        <MapView />
        {/* 第九十六轮：地图的画面暂时不可用、恢复不了时盖在地图中间的一块 */}
        <GlNote />
        {!w && !wizardOpen.value && (
          <div class="loading">
            {/* 第九十七轮：启动时打开上次的世界，过了 1 秒：到哪一步了、进度条、“取消”（那一份留着，进向导） */}
            {busy.value ? <BusyLine text={busy.value} tip={STOP_TEXT.openTip} /> : '正在准备…'}
          </div>
        )}
        {!hidden && (
          <>
            <TopBar />
            {w && <ContextBar />}
            {w && <RulerButton />}
            {w && <FitButton />}
            {/* 第九十六轮：一块画不出来（Guard）只关上这一块、顶上说一句，别的照常用；包不住的（顶栏、底部条、地图）交给根上的那一个 */}
            <Guard name="图例" watch={w}>
              <MapLegend />
              <SmokeBomb at="part" />
            </Guard>
            <Guard name="这里" watch={w}>
              <HereCard />
            </Guard>
            <Guard name="档案" watch={sheet.value} onFail={() => (sheet.value = null)}>
              <Sheet />
            </Guard>
            <Guard name="资源库" watch={libPanel.value} onFail={closeLibrary}>
              <LibPanel />
            </Guard>
            {openPanel.value && (
              <Guard name="面板" watch={openPanel.value} onFail={() => (openPanel.value = null)}>
                <PanelHost id={openPanel.value} />
              </Guard>
            )}
          </>
        )}
        {/* 第一百轮：触摸设备上是一个能点的按钮（没有 Tab 键） */}
        {hidden &&
          (touchUi() ? (
            <button class="hidden-show" onClick={() => (uiHidden.value = false)}>
              {TOUCH_TEXT.showUi}
            </button>
          ) : (
            <div class="hidden-hint">按 Tab 显示界面</div>
          ))}
        <div class="notices">
          {/* 向导开着时这一条在向导上面那一块里 */}
          {!wizardOpen.value && <BackupBanner />}
          {/* 第九十四轮：这个世界已在另一个页面打开 */}
          {!wizardOpen.value && <SaveBanner />}
          {/* 第九十五轮：这张地图也存在电脑上的文件里，这次打开页面还没在写 */}
          {!wizardOpen.value && <FileBanner />}
          <ScriptBanner />
          <SkippedBanner />
          {/* 第九十六轮：没接住的错（界面还能用）：一条，不打断 */}
          <MishapBanner />
          <Notice />
        </div>
        <CursorHint />
        <SmokeBomb at="root" />
        <Wizard />
        <Guard name="管理库" watch={packDialog.value} onFail={() => (packDialog.value = null)}>
          <PackDialog />
        </Guard>
        <Guard name="我的地图" watch={mapsDialog.value} onFail={() => (mapsDialog.value = false)}>
          <MapsDialog />
        </Guard>
        <Guard name="留着的旧世界" watch={backupsDialog.value} onFail={() => (backupsDialog.value = false)}>
          <BackupsDialog />
        </Guard>
        <Guard name="以前的版本" watch={versionsDialog.value} onFail={() => (versionsDialog.value = null)}>
          <VersionsDialog />
        </Guard>
        <Guard name="帮助" watch={helpOpen.value} onFail={() => (helpOpen.value = false)}>
          <Help />
        </Guard>
        <AskDialog />
        {/* 第一百轮：屏幕太窄（手机）时说一句 */}
        <NarrowNote />
      </div>
    </LucideProvider>
  );
}
