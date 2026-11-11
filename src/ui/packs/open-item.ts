import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import { cityList, classAt, resourceAt, worldCultures } from '../../../core/human';
import { canApply } from '../../../core/packs';
import type { CountryMeta, World } from '../../../core/world';
import { HOME, type Route } from './pages';

// 地图上点到什么就改什么（第九十二轮）：指针点到的国家、格、城市在这张地图的资源库里对应哪几项（国家 → 政体、等级、主流文化；
// 格 → 生态、文化、地形类别、资源；城市 → 城市等级；地标、点 → 它的类型），档案、“这里”卡片里每一项一行“在资源库里打开”；
// 最常用的名字、颜色在那一行上直接改（走 page-actions.ts 的 commitItem，和面板里改同一条路）。不碰界面，测试直接调

export interface LibTarget {
  // 左边灰色的两个字：“政体”“等级”
  label: string;
  kind: string;
  id: string;
  name: string;
  color?: string;
}

type Obj = Record<string, unknown>;

const itemIn = (w: World, kindId: string, id: string | undefined): { kind: ContentKind; item: Obj } | null => {
  const kind = kindOf(kindId);
  if (!kind || !id) return null;
  const item = kind.inWorld(w).find((x) => itemId(kind, x) === id) as Obj | undefined;
  return item ? { kind, item } : null;
};

// 这张地图里的一项（没有时空的）
export function libTarget(w: World, label: string, kindId: string, id: string | undefined): LibTarget[] {
  const hit = itemIn(w, kindId, id);
  if (!hit || !id) return [];
  const color = hit.item.color;
  return [{ label, kind: kindId, id, name: itemName(hit.kind, hit.item), ...(typeof color === 'string' && color.startsWith('#') ? { color } : {}) }];
}

// 国家：它的政体、等级、主流文化（世界里没有的不列：换库时留下来的锁定国家）
export function countryTargets(w: World, m: Pick<CountryMeta, 'government' | 'tier' | 'primaryCulture'>): LibTarget[] {
  return [...libTarget(w, '政体', 'government', m.government), ...libTarget(w, '等级', 'countryTier', m.tier), ...libTarget(w, '文化', 'culture', m.primaryCulture)];
}

// 一格：长着的生态、占多数的文化、地形类别、资源（海上、湖上、没有人的格只有有的那几样）
export function cellTargets(w: World, cell: number): LibTarget[] {
  if (cell < 0 || cell >= w.mesh.n) return [];
  const d = w.derived;
  const out: LibTarget[] = [];
  const land = w.causes.land[cell] === 1 && d.lake[cell] !== 1;
  if (land) {
    const sp = d.dominant[cell] >= 0 ? w.small.species[d.dominant[cell]] : undefined;
    out.push(...libTarget(w, '生态', 'biome', sp?.id));
    const code = d.popCulture?.[cell] ?? 0;
    out.push(...libTarget(w, '文化', 'culture', code ? worldCultures(w.small)[code - 1]?.id : undefined));
    out.push(...libTarget(w, '地形', 'terrainClass', classAt(w.small, d.terrainClass?.[cell] ?? 0)?.id));
    out.push(...libTarget(w, '资源', 'resource', resourceAt(w.small, d.resource?.[cell] ?? 0)?.id));
  }
  return out;
}

// 城市 → 城市等级（现算的那一级）；地标、点 → 它的类型
export function settleTargets(w: World, ref: { kind: 'city' | 'landmark' | 'point'; id: number }): LibTarget[] {
  if (ref.kind === 'city') return libTarget(w, '这一级', 'cityRank', cityList(w).find((c) => c.id === ref.id && !c.point)?.rank.id);
  if (ref.kind === 'landmark') return libTarget(w, '这一类', 'landmarkType', w.small.landmarks?.[ref.id]?.type);
  return libTarget(w, '这一类', 'pointType', w.small.points?.[ref.id]?.type);
}

// 这张地图的资源库里这一项的页面：返回先回到它那一种的列表（生态在“生态与水系”下面），再回首页
export function worldItemStack(kind: string, id: string): Route[] {
  const list: Route[] = kind === 'biome' || kind === 'riverType' || kind === 'lakeType' ? [{ p: 'ecology' }, { p: 'list', kind }] : [{ p: 'list', kind }];
  return [HOME, ...list, { p: 'item', kind, id }];
}

// ---------- 在档案、卡片里直接改名字、颜色 ----------

// 这一种在这张地图里能直接改哪两样（字段表里有、世界里能改的）
export function quickFields(kindId: string): { name: boolean; color: boolean } {
  const kind = kindOf(kindId);
  if (!kind || !canApply(kind)) return { name: false, color: false };
  const has = (key: string) => kind.fields.some((f) => f.key === key);
  return { name: has('name'), color: has('color') };
}

// 改了名字或颜色之后的这一项（交给 commitItem）；没变、名字是空的时 null
export function quickNext(w: World, kindId: string, id: string, patch: { name?: string; color?: string }): { kind: ContentKind; next: Obj } | null {
  const hit = itemIn(w, kindId, id);
  if (!hit) return null;
  const can = quickFields(kindId);
  const next: Obj = { ...hit.item };
  if (patch.name !== undefined && can.name) {
    const n = patch.name.trim();
    if (!n) return null;
    next.name = n;
  }
  if (patch.color !== undefined && can.color) next.color = patch.color;
  return next.name === hit.item.name && next.color === hit.item.color ? null : { kind: hit.kind, next };
}
