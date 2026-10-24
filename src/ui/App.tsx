import { useEffect } from 'preact/hooks';
import { settingsFor } from '../../core/presets';
import {
  type PanelId,
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
import { CATEGORY_DEFS } from './defs/tools';
import { Help } from './Help';
import { MapView } from './MapView';
import { PackApply } from './packs/PackApply';
import { MapsDialog } from './maps/MapsDialog';
import { PackDialog } from './packs/PackDialog';
import { ActionsPanel, WorldMenu } from './panels/ActionsPanel';
import { AdjustPanel } from './panels/AdjustPanel';
import { BiomePanel } from './panels/BiomePanel';
import { LayersPanel } from './panels/LayersPanel';
import { CategoryMore } from './panels/ToolLibrary';
import { RiverMore } from './panels/rivers';
import { LakeTypeMenu, NewLakeTypeMenu } from './panels/lakes';
import { IslandTypeMenu } from './panels/islandTypes';
import { NewRiverTypeMenu, RiverTypeMenu } from './panels/riverTypes';
import { ContextBar } from './shell/ContextBar';
import { HereCard } from './shell/HereCard';
import { onKeyDown, onMouseDownCapture, onPointerDownCapture } from './shell/keys';
import { AskDialog } from './shell/Ask';
import { Notice } from './shell/Notice';
import { Popover } from './shell/Popover';
import { RulerButton } from './shell/Ruler';
import { ScriptBanner } from './shell/ScriptBanner';
import { Sheet } from './shell/Sheet';
import { TopBar } from './shell/TopBar';
import { Wizard } from './Wizard';

// 整体：地图铺满全屏，界面浮在上面——顶栏、底部工具条、顶部提示条、右下角“这里”

function PanelHost({ id }: { id: PanelId }) {
  switch (id) {
    case 'world':
      return (
        <Popover id={id} title="世界" width={340}>
          <WorldMenu />
        </Popover>
      );
    case 'actions':
      return (
        <Popover id={id} title="操作" width={360}>
          <ActionsPanel />
        </Popover>
      );
    case 'adjust':
      return (
        <Popover id={id} title="调整整个世界" width={360}>
          <AdjustPanel />
        </Popover>
      );
    case 'layers':
      return (
        <Popover id={id} title="图层" width={320}>
          <LayersPanel />
        </Popover>
      );
    case 'biome':
      return (
        <Popover id={id} title="要涂的生态" width={360}>
          <BiomePanel />
        </Popover>
      );
    case 'river':
      return (
        <Popover id={id} title="这条河" width={320}>
          <RiverMore />
        </Popover>
      );
    case 'rivertype':
      return (
        <Popover id={id} title="这条河是哪一种" width={280}>
          <RiverTypeMenu />
        </Popover>
      );
    case 'newrivertype':
      return (
        <Popover id={id} title="新画的河是哪一种" width={280}>
          <NewRiverTypeMenu />
        </Popover>
      );
    case 'laketype':
      return (
        <Popover id={id} title="这个湖是哪一种" width={280}>
          <LakeTypeMenu />
        </Popover>
      );
    case 'newlaketype':
      return (
        <Popover id={id} title="新放的湖是哪一种" width={280}>
          <NewLakeTypeMenu />
        </Popover>
      );
    case 'islandtype':
      return (
        <Popover id={id} title="放哪一种岛" width={280}>
          <IslandTypeMenu which="island" />
        </Popover>
      );
    case 'chaintype':
      return (
        <Popover id={id} title="岛链用哪一种岛" width={280}>
          <IslandTypeMenu which="chain" />
        </Popover>
      );
    default: {
      // 底部工具条末尾的“⋯”：这一类的设置
      const c = id.slice(4) as keyof typeof CATEGORY_DEFS;
      return (
        <Popover id={id} title={`${CATEGORY_DEFS[c].label} · 更多设置`} width={380}>
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
  return (
    <div class={`cursor-hint ${h.warn ? 'warn' : h.caution ? 'caution' : ''}`} style={{ ...pos, top: `${h.y + 20}px` }}>
      {h.text}
    </div>
  );
}

const SEEN_HELP = 'map2.seenHelp';

export function App() {
  useEffect(() => {
    if (location.hash === '#demo') {
      void newWorld(settingsFor('region', 'tropical', 40000), [
        { op: 'set_worldgen', params: { seed: 3, type: 'archipelago' }, reset: true },
        { op: 'generate_provinces', rules: { seed: 3 } },
      ]);
    } else {
      // 回来接着做：直接打开上次的世界（上次是安全模式就照样用安全模式；带没信任过的脚本时先问）；
      // 没有、打不开（比如版本变了）、取消了再弹向导
      void resumeLast().then((ok) => {
        if (ok) showToast('已打开上次的世界');
        else wizardOpen.value = true;
      });
    }
    void loadReference();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDownCapture, true);
    window.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDownCapture, true);
      window.removeEventListener('pointerdown', onPointerDownCapture, true);
    };
  }, []);

  // 第一次用：建好第一个世界后打开一次上手说明
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
  return (
    <div class={`app ${sheet.value ? 'with-sheet' : ''}`}>
      <MapView />
      {!w && !wizardOpen.value && <div class="loading">{busy.value ?? '正在准备…'}</div>}
      {!hidden && (
        <div class="shell">
          <TopBar />
          {w && <ContextBar />}
          {w && <RulerButton />}
          <HereCard />
          <Sheet />
          <PackApply />
          {openPanel.value && <PanelHost id={openPanel.value} />}
        </div>
      )}
      {hidden && <div class="hidden-hint">按 Tab 显示界面</div>}
      <div class="notices">
        <ScriptBanner />
        <Notice />
      </div>
      <CursorHint />
      <Wizard />
      <PackDialog />
      <MapsDialog />
      <Help />
      <AskDialog />
    </div>
  );
}
