import type { Command } from '../commands';
import { itemId, kindByPackKey } from '../content/registry';
import { type Era, type PopValue, type ValueGroup, worldEra, worldEras } from '../human/era';
import { type PackNode, type PackPicks, type PackWorld, ownItems, planPack, walkPacks } from '../packs';
import type { PackRoot } from './import';

// 从资源库给世界加一个变量（第五十四轮）：界面的入口和第六十一轮的导入窗口都走这里。
// 计算 Worker 没有内置的数据，取值的定义在主线程放进命令：一个批量，先加取值（一模一样的跳过，同 id 不同内容的改名），再 add_dimension。
// 世界的时代已经有的维度不列，已经有的取值不加第二份

export interface DimensionOption {
  id: string;
  label: string;
  // 哪个库里找到的（资源库里的键）
  library: string;
  values: { id: string; name: string; color: string }[];
}

// 一个库的树里这一维的取值、取值组（同 id 取第一次出现的），各自的小包路径
function dimensionItems(root: PackRoot, dim: string) {
  const values = new Map<string, { item: PopValue; path: string[] }>();
  const groups = new Map<string, { item: ValueGroup; path: string[] }>();
  walkPacks(root.pack, (n, rel) => {
    for (const v of ownItems<PopValue>(n, 'popValues')) if (v.dimension === dim && !values.has(v.id)) values.set(v.id, { item: v, path: [root.key, ...rel] });
    for (const g of ownItems<ValueGroup>(n, 'valueGroups')) if (g.dimension === dim && !groups.has(g.id)) groups.set(g.id, { item: g, path: [root.key, ...rel] });
  });
  return { values, groups };
}

type Small = PackWorld['small'];
const targetEra = (small: Small): Era | undefined => worldEra(small) ?? (worldEras(small).length === 1 ? worldEras(small)[0] : undefined);

// 资源库里能加的变量：各库的时代写了、库里有取值、世界的时代还没有的。同一个 id 在几个库里时列第一个（资源库的先后）
export function dimensionOptions(library: readonly PackRoot[], small: Small): DimensionOption[] {
  const era = targetEra(small);
  if (!era) return [];
  const have = new Set(era.dimensions.map((d) => d.id));
  const out: DimensionOption[] = [];
  for (const root of library) {
    walkPacks(root.pack, (n) => {
      for (const e of ownItems<Era>(n, 'eras')) {
        for (const d of e.dimensions) {
          if (have.has(d.id)) continue;
          const { values } = dimensionItems(root, d.id);
          if (!values.size) continue;
          have.add(d.id);
          out.push({ id: d.id, label: d.label, library: root.key, values: [...values.values()].map(({ item }) => ({ id: item.id, name: item.name, color: item.color })) });
        }
      }
    });
  }
  return out;
}

// 加这个变量的命令（一步，可以撤销）。library 省略时用 dimensionOptions 列的那个库；找不到时 null
export function addDimensionCommand(library: readonly PackRoot[], world: PackWorld, dimId: string, from?: string): Command | null {
  const option = dimensionOptions(library, world.small).find((o) => o.id === dimId && (!from || o.library === from));
  const root = library.find((r) => r.key === (from ?? option?.library));
  const era = targetEra(world.small);
  if (!option || !root || !era) return null;
  const { values, groups } = dimensionItems(root, dimId);
  const merged: PackNode = { id: 'dimension', name: option.label, valueGroups: [...groups.values()].map((x) => x.item), popValues: [...values.values()].map((x) => x.item) };
  const picks: PackPicks = { defaultStyle: null };
  for (const key of ['valueGroups', 'popValues']) picks[key] = (merged[key] as unknown[]).map((x) => itemId(kindByPackKey(key)!, x));
  const origin = (key: string, id: string) => (key === 'popValues' ? values.get(id)?.path : key === 'valueGroups' ? groups.get(id)?.path : undefined);
  const plan = planPack(world, merged, picks, { origin, label: option.label });
  return { op: 'batch', label: `加变量“${option.label}”`, commands: [...plan.command.commands, { op: 'add_dimension', dimension: { id: option.id, label: option.label }, era: era.id }] };
}
