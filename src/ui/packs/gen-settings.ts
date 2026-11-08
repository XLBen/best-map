import type { Command } from '../../../core/commands';
import { type ContentKind, type FieldDesc, kindOf } from '../../../core/content/registry';
import { type Era, worldEra } from '../../../core/human';
import type { ProvinceRules } from '../../../core/province-rules';
import type { PackWorld } from '../../../core/packs';
import type { Obj } from './fields';
import { worldItemCommand } from './page-actions';
import type { PageCtx } from './page-source';
import type { Route } from './pages';

// 生成设置（第八十一轮）：资源库首页最上面一张卡片，打开一页最常调的几项——国家大小、人口密度、城市化率、国家等级的比例（时代的）、
// 省份大小（省份划分的）。改的是本世界的那一项，和那一项自己的页面同一条命令（page-actions.ts 的 commitItem / worldItemCommand），
// 所以撤销、底下的“改了 N 项 · 重新生成”都一样。字段就是登记表里的那几个（单位、滑块、说明同一份）。不碰界面，测试直接调

// 时代的几项：这几个字段按先后
export const GEN_ERA_KEYS: readonly string[] = ['countryKm2', 'popDensity', 'urbanization'];
export const GEN_PROVINCE_KEYS: readonly string[] = ['size'];

export interface GenTarget<T> {
  kind: ContentKind;
  id: string;
  item: T;
  fields: readonly FieldDesc[];
  // 这一项自己的页面（“更多”）
  route: Route;
}

export interface GenPage {
  era: GenTarget<Era> | null;
  provinces: GenTarget<ProvinceRules> | null;
  // 时代的国家等级的比例那个字段
  tiers: FieldDesc | null;
}

const pickFields = (kind: ContentKind, keys: readonly string[]): FieldDesc[] => keys.flatMap((k) => kind.fields.filter((f) => f.key === k));

// 本世界的时代（生成过人文时）和省份划分（世界里有一份时）
export function genPage(ctx: PageCtx): GenPage | null {
  const w = ctx.world;
  if (!w) return null;
  const eraKind = kindOf('era');
  const provKind = kindOf('provinceRules');
  const e = worldEra(w.small);
  const rulesList = provKind ? (provKind.inWorld(w) as ProvinceRules[]) : [];
  const r = rulesList[0];
  return {
    era: eraKind && e ? { kind: eraKind, id: e.id, item: e, fields: pickFields(eraKind, GEN_ERA_KEYS), route: { p: 'item', kind: 'era', id: e.id, seg: 'state' } } : null,
    provinces: provKind && r ? { kind: provKind, id: r.id, item: r, fields: pickFields(provKind, GEN_PROVINCE_KEYS), route: { p: 'item', kind: 'provinceRules', id: r.id, seg: 'size' } } : null,
    tiers: eraKind?.fields.find((f) => f.key === 'tiers') ?? null,
  };
}

// 改一项：和这一项的页面同一条命令（时代整个换掉），历史里写改的是哪一项（“改国家大小”）。没变时 null
export function genCommand<T>(t: GenTarget<T>, next: Obj, w: PackWorld, what?: string): Command | null {
  const cmd = worldItemCommand(t.kind, t.id, next, w);
  return cmd && what && cmd.op === 'batch' ? { ...cmd, label: `改${what}` } : cmd;
}

// 卡片上的一句：“国家 8 万 km² · 人口 2 人/km² · 省 40 格”
export function genSummary(p: GenPage): string {
  const parts: string[] = [];
  const e = p.era?.item;
  if (e?.countryKm2) parts.push(`国家 ${areaText(e.countryKm2)}`);
  if (e) parts.push(`人口 ${e.popDensity} 人/km²`);
  if (p.provinces) parts.push(`省 ${p.provinces.item.size} 格`);
  return parts.join(' · ');
}

const areaText = (km2: number): string => (km2 >= 1e4 ? `${Number((km2 / 1e4).toPrecision(3))} 万 km²` : `${km2} km²`);
