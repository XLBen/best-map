import type { ComponentType } from 'preact';

// 工具表里引用的小部件（第六十九轮）：底部条上的自定义项（“岛：珊瑚岛 ▾”、选中的河的设置……）和每一类的“⋯”里的设置。
// 工具表（tools.ts）只写名字；部件写在 panels/ 下，在自己的模块里 registerPanels 登记（register-all.ts 把它们都引用一次）。
// 与 core/human/generate.ts 的 registerHumanStage 一样：声明的一方不引用实现的一方，不绕成圈

export const PANEL_KEYS = [
  // 地形
  'IslandTypePick',
  'ChainTypePick',
  'ChainFragSlider',
  'TerrainExtras',
  'ClassPick',
  // 自然
  'BiomeChip',
  'UnmetChip',
  'RangeBar',
  'ResourcePick',
  'NatureExtras',
  // 水系
  'RiverBar',
  'NewRiverTypePick',
  'LakeBar',
  'NewLakeTypePick',
  'RiverExtras',
  // 省份
  'ProvinceColorToggle',
  'ProvinceBar',
  'ProvincePick',
  'ProvinceExtras',
  // 地名
  'NamesBar',
  'NamesExtras',
  // 文化
  'NoHumanChip',
  'CulturePick',
  'PopTuplePick',
  'ValuePick',
  'FactorSlider',
  'HearthBar',
  'CultureExtras',
  // 国家
  'NoCountryChip',
  'SelectedCountryChip',
  'TerritoryPick',
  'CountryExtras',
  // 城市
  'NoCityChip',
  'CityBar',
  'CityPointChip',
  'RoadBar',
  'LandmarkPick',
  'LandmarkChip',
  'PointPick',
  'PointChip',
  'SettlementExtras',
] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];

const panels = new Map<PanelKey, ComponentType>();

export function registerPanels(table: Partial<Record<PanelKey, ComponentType>>) {
  for (const [key, c] of Object.entries(table) as [PanelKey, ComponentType][]) panels.set(key, c);
}

export function panelOf(key: PanelKey): ComponentType {
  const c = panels.get(key);
  if (!c) throw new Error(`没有登记的部件：${key}（见 register-all.ts）`);
  return c;
}

// 登记了的（测试查全不全）
export const registeredPanels = (): PanelKey[] => [...panels.keys()];
