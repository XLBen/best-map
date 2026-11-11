import { ChevronRight, Plus } from 'lucide-preact';
import { useRef } from 'preact/hooks';
import { ISLAND_SHAPE_INFO, type IslandType, allIslandTypes, islandTypeById, islandTypesOf, liveIslandKind } from '../../../core/island-types';
import { openPanel, options, setOptions, world } from '../../state';
import { TypePicker, TypePickerButton } from '../shell/TypePicker';
import { Slider } from '../components/Slider';
import { openWorldItem } from '../packs/panel-store';
import { KEY, type Which, createAndUse, islandSwatch } from './island-types';
import { registerPanels } from '../defs/panel-registry';

// 岛的种类（第十四轮）：放岛、画岛链底部条上“岛：珊瑚岛 ▾”的按钮、弹出的列表（最后一项“新建…”），
// “地形 ⋯”里的“岛的种类”（选择用的列表；改在资源库里这一种的页面，第九十三轮）

const hintOf = (t: IslandType) => (t as { hint?: string }).hint ?? `${ISLAND_SHAPE_INFO[t.shape].name} · ${t.province === 'sea' ? '归海省' : '归陆地省'}`;

const PANEL: Record<Which, 'islandtype' | 'chaintype'> = { island: 'islandtype', chain: 'chaintype' };

function TypePick({ which }: { which: Which }) {
  const w = world.value;
  if (!w) return null;
  const t = islandTypeById(w.small, liveIslandKind(w, options.value[KEY[which]]));
  return <TypePickerButton panel={PANEL[which]} prefix="岛" swatch={islandSwatch(t)} name={t?.name ?? '大陆岛'} title={t ? hintOf(t) : '岛的种类'} />;
}

// 放岛工具条上的“岛：X ▾”
export const IslandTypePick = () => <TypePick which="island" />;
// 画岛链工具条上的“岛：X ▾”（岛链有自己的选择，放岛时选了小礁不影响岛链）
export const ChainTypePick = () => <TypePick which="chain" />;

// 画岛链工具条上的“碎岛 0–100%”（第十八轮）：按链上的编号把这么多的岛换成碎岛（不随机），100% 全是碎岛。
// 拖的时候正在画的岛链跟着变；种类本身是碎岛时用不上（全是碎岛），不显示
export function ChainFragSlider() {
  const w = world.value;
  const start = useRef<number | null>(null);
  if (!w || islandTypeById(w.small, liveIslandKind(w, options.value.chainKind))?.shape === 'frag') return null;
  const v = options.value.chainFrag;
  const snap = (p: number) => Math.round(Math.max(0, Math.min(1, p)) * 20) / 20;
  return (
    <Slider
      label="碎岛"
      pos={v}
      text={`${Math.round(v * 100)}%`}
      textAt={(p) => `${Math.round(snap(p) * 100)}%`}
      title="岛链里碎岛的比例"
      onDraft={(p) => {
        start.current ??= v;
        setOptions({ chainFrag: snap(p) });
      }}
      onCommit={(p) => {
        start.current = null;
        setOptions({ chainFrag: snap(p) });
      }}
      onCancel={() => {
        if (start.current !== null) setOptions({ chainFrag: start.current });
        start.current = null;
      }}
    />
  );
}

// 弹出的列表：内置的五种、自己的几种，最后一项“新建…”（新建一种、用上它，并打开它的设置）
export function IslandTypeMenu({ which }: { which: Which }) {
  const w = world.value;
  if (!w) return null;
  const cur = liveIslandKind(w, options.value[KEY[which]]);
  const pick = (id: string) => {
    setOptions({ [KEY[which]]: id });
    openPanel.value = null;
  };
  return (
    <TypePicker
      items={allIslandTypes(w.small).map((t) => ({
        id: t.id,
        label: t.name,
        swatch: islandSwatch(t),
        on: cur === t.id,
        hint: hintOf(t),
        meta: ISLAND_SHAPE_INFO[t.shape].name,
        onPick: () => pick(t.id),
      }))}
      onNew={() => void createAndUse(which)}
      newLabel="新建…"
      newTitle="新建一种岛，在资源库里改"
      library="islandType"
    />
  );
}

// ---------- “地形 ⋯”里的“岛的种类” ----------

// 第九十三轮：这里以前有另一个编辑器（名字、颜色、形状、高低、岩石、起名）。并进了资源库里这一种的页面——
// 只留选择用的列表：点一种直达资源库里的那一页，新建也是
export function IslandTypesSection() {
  const w = world.value;
  if (!w) return null;
  const own = islandTypesOf(w.small);
  return (
    <section>
      <h5>岛的种类</h5>
      <p class="hint">点一种在资源库里改</p>
      {own.length > 0 && (
        <div class="list">
          {own.map((t) => (
            <div class="item" key={t.id} role="button" tabIndex={0} title="在资源库里打开" onClick={() => openType(t.id)} onKeyDown={(e) => e.key === 'Enter' && openType(t.id)}>
              <span class="grow ellipsis">
                <span class="swatch" style={{ background: islandSwatch(t) }} /> {t.name}
              </span>
              <span class="hint">
                {ISLAND_SHAPE_INFO[t.shape].name}
                {t.province === 'sea' ? ' · 归海省' : ''}
              </span>
              <ChevronRight />
            </div>
          ))}
        </div>
      )}
      <div class="row wrap">
        <button class="small" onClick={() => void createAndUse(null)}>
          <Plus /> 新建
        </button>
      </div>
    </section>
  );
}

// 这一种在资源库里的页面（“⋯”先收起）
function openType(id: string) {
  openPanel.value = null;
  openWorldItem('islandType', id);
}

// 地形这一类的“⋯”
export function TerrainExtras() {
  return <IslandTypesSection />;
}

// 工具表里按名字引用的部件（defs/panel-registry.ts）
registerPanels({ IslandTypePick, ChainTypePick, ChainFragSlider, TerrainExtras });
