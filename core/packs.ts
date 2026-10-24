import { z } from 'zod';
import zhCN from 'zod/v4/locales/zh-CN.js';
import type { Command } from './commands';
import './content/kinds';
import { type ContentKind, type PackContext, type Renames, allKinds, itemId, kindByPackKey, kindOf, registryVersion } from './content/registry';
import { ITEM_ID, sameItem, stableJson } from './content/refs';
import { DEFAULT_STYLE, type NameStyle } from './name-styles';
import { DEFAULT_PACK } from './names';
import type { PlanetForm } from './planet-form';
import { type FoundScript, findScripts } from './script';
import type { Species } from './species';
import type { World } from './world';

// 资源包（第三批，*.map2pack.json）：几种生态、河流类型、星球形态、地名风格放在一个文件里，导入、导出、用到世界。
//
//   {format: 'map2-pack', version: 1, id, name, author?, description?, fields?, biomes?, riverTypes?, lakeTypes?, islandTypes?,
//    planetForms?, nameStyles?}（旧文件里的 textPacks 是模板式的地名风格，照旧读）
//
// 第二十轮起，有哪几段、每段的格式、数、列表的一行、检查、撞 id 改名、从世界导出，都由内容种类的登记表（content/registry.ts，
// 各种类登记在 content/kinds.ts）推出来；加一种内容只要登记一次。
// 顶层严格：不认识的部分直接报错（“不认识的部分：xxx”），不悄悄丢掉。读包只做解析与检查，不运行任何脚本。
// 用到世界是一整步（一个 batch，可撤销）：先加用到的自定义场，再加各项；世界里已有一模一样的项跳过，
// 同 id 不同内容的改名为 “id-2”，包里对它的引用（侵占的目标、river('x')）一起改；噪声种子用固定的 seedKey，改名不改花纹。
// 世界自带它用到的全部内容（都在命令里），别人没有这个包也能打开。

export const PACK_FORMAT = 'map2-pack';
export const PACK_VERSION = 1;
const PACK_EXT = '.map2pack.json';
// 文件最多这么多字（脚本最长 2 万字，256 种生态各两段也到不了）
export const PACK_MAX_CHARS = 16_000_000;

// 一个文件里每段最多这么多项（再多就不像是资源包了：一下子加几百种生态，大星球上会算不动）。由登记表推出
export const PACK_MAX: Readonly<Record<string, number>> = new Proxy({} as Record<string, number>, {
  get: (_, key) => (typeof key === 'string' ? kindByPackKey(key)?.pack.max : undefined),
});

export type PackWorld = Pick<World, 'small' | 'causes'>;

// 每一项至少是带 id 的对象（名字、颜色可选，其余原样保留）
export interface PackItem {
  id: string;
  name?: string;
  color?: string;
  [k: string]: unknown;
}

// 资源包里的一段（就是登记表里的一种内容）
export function packSection(key: string): ContentKind | undefined {
  return kindByPackKey(key);
}

// 列出来的几段（有段名、可以勾选的；自定义场跟着别的自动加，不列），按登记的先后
export function packSections(): ContentKind[] {
  return allKinds().filter((k) => k.pack.listed);
}

// ---------- 格式 ----------

const META_KEYS = ['format', 'version', 'id', 'name', 'author', 'description'] as const;

// 顶层的结构（严格）：各段先按“列表”收下，在 parsePack 里按登记的格式逐项再查。登记表变了重新建
let topCache: { version: number; schema: z.ZodType } | null = null;
function topSchema(): z.ZodType {
  if (topCache?.version === registryVersion()) return topCache.schema;
  const shape: Record<string, z.ZodType> = {
    format: z.literal(PACK_FORMAT),
    version: z.literal(PACK_VERSION),
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(60),
    author: z.string().max(60).optional(),
    description: z.string().max(2000).optional(),
  };
  for (const k of allKinds()) for (const key of [k.pack.key, ...(k.pack.aliases ?? [])]) shape[key] = z.array(z.unknown()).max(k.pack.max).optional();
  topCache = { version: registryVersion(), schema: z.strictObject(shape) };
  return topCache.schema;
}

export interface ResourcePack {
  format: typeof PACK_FORMAT;
  version: typeof PACK_VERSION;
  id: string;
  name: string;
  author?: string;
  description?: string;
  fields?: string[];
  biomes?: Species[];
  riverTypes?: PackItem[];
  lakeTypes?: PackItem[];
  islandTypes?: PackItem[];
  planetForms?: PackItem[];
  nameStyles?: NameStyle[];
  // 以后的种类（文化、时代……）按登记的段名
  [section: string]: unknown;
}

// 包里一段的项（没有时是空的）
export function packItems<T = unknown>(pack: ResourcePack, key: string): T[] {
  const v = pack[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

// 出错说明：顶层多出来的部分说“不认识的部分”，类型不对、缺项用中文说，其余用 zod 的中文
const zh = zhCN().localeError;
const TYPE_ZH: Record<string, string> = { string: '文字', number: '数', boolean: '是或否', array: '列表', object: '一组设置' };
const packErrorMap: z.core.$ZodErrorMap = (iss) => {
  if (iss.code === 'unrecognized_keys') return `${iss.path?.length ? '不认识的项' : '不认识的部分'}：${iss.keys.join('、')}`;
  if (iss.code === 'invalid_type') return iss.input === undefined ? '缺少这一项' : `应该是${TYPE_ZH[iss.expected] ?? iss.expected}`;
  if (iss.code === 'invalid_value' && iss.path?.length === 1 && iss.path[0] === 'version') return `资源包格式是第 ${String(iss.input)} 版，只支持第 ${PACK_VERSION} 版`;
  // 长短、多少：说人话（zod 的中文是“数值过小：期望 string >=1 字符”）
  if (iss.code === 'too_small' && iss.origin === 'string') return Number(iss.minimum) <= 1 ? '不能是空的' : `太短，至少 ${String(iss.minimum)} 个字`;
  if (iss.code === 'too_big' && iss.origin === 'string') return `太长，最多 ${String(iss.maximum)} 个字`;
  if (iss.code === 'too_big' && iss.origin === 'array') return `太多，最多 ${String(iss.maximum)} 个`;
  return zh(iss);
};

const TOP_ZH: Record<string, string> = { format: '格式', id: '资源包的 id', name: '资源包的名字', author: '作者', description: '说明' };

// 出错的位置：“生态第 2 个「crystal」的 color”
function where(path: readonly PropertyKey[], json: unknown): string {
  if (!path.length) return '';
  const [head, idx, ...rest] = path;
  // 版本不对的说明本身就说清楚了
  if (path.length === 1 && head === 'version') return '';
  const sec = kindByPackKey(String(head))?.label;
  // 整个部分的问题（比如生态太多）
  if (sec && path.length === 1) return sec;
  if (!sec || typeof idx !== 'number') return path.length === 1 && TOP_ZH[String(head)] ? TOP_ZH[String(head)] : path.map(String).join('.');
  const raw = (json as Record<string, unknown[]>)[String(head)]?.[idx] as { id?: unknown; name?: unknown } | undefined;
  const label = typeof raw?.name === 'string' && raw.name ? raw.name : typeof raw?.id === 'string' ? raw.id : '';
  return `${sec}第 ${idx + 1} 个${label ? `“${label}”` : ''}${rest.length ? `的 ${rest.map(String).join('.')}` : ''}`;
}

function issuesText(issues: readonly z.core.$ZodIssue[], json: unknown, prefix: PropertyKey[] = []): string[] {
  return issues.map((i) => {
    const at = where([...prefix, ...i.path], json);
    return at ? `${at}：${i.message}` : i.message;
  });
}

export type PackParse = { ok: true; pack: ResourcePack } | { ok: false; errors: string[] };

// 校验一个资源包（已经是 JSON 值）。只解析、检查，不运行脚本。别名里的项（旧的 textPacks）读进那一种的段里
export function parsePack(json: unknown): PackParse {
  const top = topSchema().safeParse(json, { error: packErrorMap });
  if (!top.success) return { ok: false, errors: issuesText(top.error.issues, json) };
  const data = top.data as Record<string, unknown>;
  const pack = {} as ResourcePack;
  for (const k of META_KEYS) if (data[k] !== undefined) (pack as Record<string, unknown>)[k] = data[k];
  const errors: string[] = [];
  for (const kind of allKinds()) {
    let any = false;
    const parsed: unknown[] = [];
    for (const key of [kind.pack.key, ...(kind.pack.aliases ?? [])]) {
      const list = data[key] as unknown[] | undefined;
      if (!list) continue;
      any = true;
      list.forEach((raw, k) => {
        const item = kind.pack.read ? kind.pack.read(raw, key === kind.pack.key ? undefined : key) : raw;
        const r = kind.schema.safeParse(item, { error: packErrorMap });
        if (r.success) parsed.push(r.data);
        else errors.push(...issuesText(r.error.issues, json, [key, k]));
      });
    }
    if (any) pack[kind.pack.key] = parsed;
  }
  return errors.length ? { ok: false, errors } : { ok: true, pack };
}

// 从文件读出来：资源包，或者旧的格式——生态数组（以前“生态 → 导出”的文件）、文字包。
// 都转成资源包，走同一条检查、信任的路。legacy 说明原来是什么（界面按原来的意思用：旧的生态文件是整套换掉）
export type PackRead = { ok: true; pack: ResourcePack; legacy: 'biomes' | 'wordPack' | null } | { ok: false; errors: string[] };

// name：旧的生态文件没有名字，用这个（一般是文件名）
export function readPack(text: string, name = '生态'): PackRead {
  if (text.length > PACK_MAX_CHARS) return { ok: false, errors: [`文件太大（超过 ${Math.round(PACK_MAX_CHARS / 1e6)} MB），不是资源包`] };
  let json: unknown;
  try {
    // 记事本存的 UTF-8 文件开头可能带一个看不见的 BOM
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, errors: [`不是 JSON 文件（${(e as Error).message}）`] };
  }
  if (Array.isArray(json)) {
    const label = name.trim().slice(0, 60) || '生态';
    const wrapped = { format: PACK_FORMAT, version: PACK_VERSION, id: packIdFor(label), name: label, biomes: json };
    const r = parsePack(wrapped);
    return r.ok ? { ...r, legacy: 'biomes' } : r;
  }
  if (json !== null && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (o.format === PACK_FORMAT) {
      const r = parsePack(json);
      return r.ok ? { ...r, legacy: null } : r;
    }
    if (o.format === undefined && 'types' in o && ('lists' in o || o.kind === 'phonetic')) {
      // 单独的文字包、地名风格：包一层，按资源包整个查一遍（资源包的名字、id 有长短限制，文字包的没有：太长的截短，存进资源库后才列得出来）
      const label = (typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '') || '地名风格';
      const wrapped = { format: PACK_FORMAT, version: PACK_VERSION, id: packIdFor(typeof o.id === 'string' ? o.id : label), name: label, nameStyles: [json] };
      const r = parsePack(wrapped);
      return r.ok ? { ...r, legacy: 'wordPack' } : r;
    }
  }
  return { ok: false, errors: ['不认识的文件：不是资源包、生态或地名风格'] };
}

// ---------- 内容 ----------

// 每段有几项（按段名）
export function packCounts(pack: ResourcePack): Record<string, number> {
  return Object.fromEntries(allKinds().map((k) => [k.pack.key, packItems(pack, k.pack.key).length]));
}

// 列表里的一行：“生态 5 · 河流 4 · 星球 3”（数从数据来，没有的不写）
export function packSummary(pack: ResourcePack): string {
  const parts: string[] = [];
  for (const k of packSections()) {
    const n = packItems(pack, k.pack.key).length;
    if (n) parts.push(`${k.short} ${n}`);
  }
  return parts.join(' · ') || '空的';
}

// 文件名：<名字>.map2pack.json（名字里不能做文件名的字符换成 -）
export function packFileName(pack: Pick<ResourcePack, 'name' | 'id'>): string {
  const slug = (pack.name || pack.id)
    .trim()
    .replace(/[\s/\\:*?"<>|.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'pack'}${PACK_EXT}`;
}

// 从名字得到资源包的 id（资源库按它存：同名的再存一次是更新）
export function packIdFor(name: string): string {
  return (
    name
      .trim()
      .replace(/[\s/\\:*?"<>|.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'pack'
  );
}

export { sameItem };

// sameItem 比较用的键：要和许多项比的时候每项只算一次（向导、调整里列出的星球形态去重）
export const itemKey = (v: unknown): string => stableJson(v);

// 包里（或一条命令里、任意 JSON 里）的全部脚本：信任检查、“查看脚本”用
export function packScripts(json: unknown): FoundScript[] {
  return findScripts(json);
}

// 脚本里的引用（拆到 content/refs.ts，这里照旧导出）
export { biomeFields, rewriteRiverRefs, scriptRefs } from './content/refs';
export type { Renames } from './content/registry';
export { exportableBiomes } from './content/kinds';

// ---------- 检查 ----------

// 包里的问题（不挡导入，列出来给用户看）：重复的 id、指向不存在的东西的引用、地名风格里不存在的词表、生态太多……
export function packProblems(pack: ResourcePack): string[] {
  const problems: string[] = [];
  const kinds = allKinds();
  for (const k of kinds) {
    if (!k.pack.listed) continue;
    const seen = new Set<string>();
    for (const x of packItems(pack, k.pack.key)) {
      const id = itemId(k, x);
      if (seen.has(id)) problems.push(`有两个${k.label}的 id 都是 ${id}`);
      seen.add(id);
    }
  }
  // 模板式起名能用的词表：内置中文的、包里模板式风格的，加上起名时才放进去的 __species
  const styles = packItems<NameStyle>(pack, 'nameStyles');
  const lists = new Set([...Object.keys(DEFAULT_PACK.lists), ...styles.flatMap((s) => (s.kind === 'template' ? Object.keys(s.lists) : [])), '__species']);
  const ctx: PackContext = {
    ids: (key) => {
      const k = kindByPackKey(key);
      return new Set(k ? packItems(pack, key).map((x) => itemId(k, x)) : []);
    },
    fields: new Set(pack.fields ?? []),
    lists,
  };
  for (const k of kinds) if (k.pack.problems) problems.push(...k.pack.problems(packItems(pack, k.pack.key), ctx));
  return problems;
}

// ---------- 用到世界 ----------

// 要用哪些项：按段名给 id 列表（省略的段不用）；defaultStyle：用了之后世界默认用这种地名风格（null 或省略为不换）
export interface PackPicks {
  biomes?: readonly string[];
  riverTypes?: readonly string[];
  lakeTypes?: readonly string[];
  islandTypes?: readonly string[];
  nameStyles?: readonly string[];
  defaultStyle?: string | null;
  [key: string]: readonly string[] | string | null | undefined;
}

// 一段勾了哪些
export function pickedIds(picks: PackPicks, key: string): readonly string[] | undefined {
  const v = picks[key];
  return Array.isArray(v) ? v : undefined;
}

// 这一段能不能用到世界（有启用的命令）
export const canApply = (k: ContentKind): boolean => k.enable !== undefined || k.store === 'content';

// 能用到世界的几段，按用到世界的先后
const applicable = () =>
  packSections()
    .filter(canApply)
    .sort((a, b) => a.order - b.order);

// 默认勾选：能用的几段按各自的规则（省略时全勾）；地名风格勾上但不换世界默认
export function defaultPicks(pack: ResourcePack): PackPicks {
  const picks: PackPicks = { defaultStyle: null };
  for (const k of packSections()) {
    if (!canApply(k)) continue;
    picks[k.pack.key] = k.pack.checked ? packItems(pack, k.pack.key).filter((x) => k.pack.defaultPick?.(x) ?? true).map((x) => itemId(k, x)) : [];
  }
  return picks;
}

// 改名表里的段名（以前叫 PackSectionName）
export type PackSectionName = string;

export interface PackPlan {
  command: Extract<Command, { op: 'batch' }>;
  // 新加进世界的项（from 是包里的 id，id 是世界里的；改了名的两者不同）
  added: { section: PackSectionName; from: string; id: string; name: string }[];
  // 世界里已有一模一样的，跳过（id 是世界里那一项的）
  skipped: { section: PackSectionName; from: string; id: string; name: string }[];
  // 新加的自定义场
  fields: string[];
  // 用了之后世界默认的地名风格（世界里已经是它时为 null）
  defaultStyle: string | null;
}

// 给包里的一类项定下用到世界时的 id：没有冲突的照旧；世界里有一模一样的跳过（引用指向世界里那一项）；
// 同 id 不同内容的改名为 id-2、id-3……（跳过也看改了名的那一项：同一个包用两次，第二次全部跳过）
function assignIds(kind: ContentKind, items: readonly unknown[], worldItems: readonly unknown[], finalOf: (item: unknown, id: string) => unknown): { ids: Map<string, string>; skip: Set<string> } {
  const idOf = (x: unknown) => itemId(kind, x);
  const byId = new Map(worldItems.map((x) => [idOf(x), x]));
  const ids = new Map<string, string>();
  const skip = new Set<string>();
  // 包里自己的 id 先占上（不用改名的那些），改名时避开
  const taken = new Set([...byId.keys(), ...items.filter((x) => !byId.has(idOf(x))).map(idOf)]);
  for (const item of items) {
    const id0 = idOf(item);
    if (!byId.has(id0)) {
      ids.set(id0, id0);
      continue;
    }
    for (let k = 1; ; k++) {
      const cand = k === 1 ? id0 : `${id0}-${k}`;
      const there = byId.get(cand);
      if (there && sameItem(there, finalOf(item, cand))) {
        ids.set(id0, cand);
        skip.add(id0);
        break;
      }
      if (k > 1 && !there && !taken.has(cand)) {
        ids.set(id0, cand);
        taken.add(cand);
        break;
      }
    }
  }
  return { ids, skip };
}

// 同一个 id 在包里出现几次时只用第一个（packProblems 会提醒）
function firstOfEach(kind: ContentKind, items: readonly unknown[], ids: readonly string[] | undefined): unknown[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const id = itemId(kind, x);
    return ids?.includes(id) && !seen.has(id) && (seen.add(id), true);
  });
}

// 加进世界的最终样子：引用跟着改名 → 换 id → 最后一步（自然生成关掉……）
function finalItem(kind: ContentKind, x: unknown, id: string, r: Renames): unknown {
  const p = kind.pack;
  const re = p.rewrite ? p.rewrite(x, r) : x;
  const out = id === itemId(kind, x) ? re : p.withId ? p.withId(re, id, itemId(kind, x)) : { ...(re as object), id };
  return p.finalize ? p.finalize(out, r) : out;
}

// 资源包用到世界的计划：一整步（batch，标签“用上资源包“X””）
export function planPack(world: PackWorld, pack: ResourcePack, picks: PackPicks): PackPlan {
  const kinds = applicable();
  const picked = new Map<ContentKind, unknown[]>();
  const inWorld = new Map<ContentKind, readonly unknown[]>();
  for (const k of kinds) {
    picked.set(k, firstOfEach(k, packItems(pack, k.pack.key), pickedIds(picks, k.pack.key)));
    inWorld.set(k, k.inWorld(world));
  }

  // 改名表要一起定：生态 A 侵占生态 B 时，A 是不是一模一样还要看 B 改没改名。反复几遍直到不再变
  const emptyRenames = (): Renames => ({ biomes: new Map(), riverTypes: new Map(), lakeTypes: new Map() });
  let renames = emptyRenames();
  let assigned = new Map<ContentKind, ReturnType<typeof assignIds>>();
  const flat = (r: Renames) => stableJson(kinds.map((k) => [...(r[k.pack.key] ?? [])]));
  const toRenames = (a: Map<ContentKind, ReturnType<typeof assignIds>>): Renames => {
    const r = emptyRenames();
    for (const [k, v] of a) r[k.pack.key] = v.ids;
    return r;
  };
  for (let round = 0; round < 6; round++) {
    assigned = new Map(kinds.map((k) => [k, assignIds(k, picked.get(k)!, inWorld.get(k)!, (x, id) => finalItem(k, x, id, renames))]));
    const next = toRenames(assigned);
    if (flat(next) === flat(renames)) break;
    renames = next;
  }
  renames = toRenames(assigned);

  // 加了、跳过的按登记的先后列（生态在前）；命令按用到世界的先后
  const added: PackPlan['added'] = [];
  const skipped: PackPlan['skipped'] = [];
  const cmdsOf = new Map<ContentKind, Command[]>();
  const newFields: string[] = [];
  for (const k of packSections().filter((x) => assigned.has(x))) {
    const a = assigned.get(k)!;
    const cmds: Command[] = [];
    cmdsOf.set(k, cmds);
    for (const x of picked.get(k)!) {
      const from = itemId(k, x);
      const id = a.ids.get(from)!;
      if (a.skip.has(from)) {
        skipped.push({ section: k.pack.key, from, id, name: nameOf(k, x) || from });
        continue;
      }
      const item = finalItem(k, x, id, renames);
      cmds.push(k.enable ? k.enable(item, world) : { op: 'set_content', kind: k.id, id, item: item as Record<string, unknown> });
      // 名字是加进世界后的（改了名的带编号）
      added.push({ section: k.pack.key, from, id, name: nameOf(k, item) || id });
      newFields.push(...(k.pack.fieldsOf?.(item) ?? []));
    }
  }
  const itemCmds = kinds.flatMap((k) => cmdsOf.get(k) ?? []);

  // 新加的项用到、世界里还没有的自定义场
  const have = new Set(Object.keys(world.causes.fields));
  const fields: string[] = [];
  for (const f of newFields) if (ITEM_ID.test(f) && !have.has(f) && !fields.includes(f)) fields.push(f);

  // 世界默认的地名风格：包里的这一种（改了名的按新 id）；世界里已经是它时不换
  const styleIds = renames.nameStyles;
  const wanted = picks.defaultStyle ? (styleIds?.get(picks.defaultStyle) ?? (picks.defaultStyle === DEFAULT_STYLE ? DEFAULT_STYLE : undefined)) : undefined;
  const defaultStyle = wanted && wanted !== (world.small.nameStyle ?? DEFAULT_STYLE) ? wanted : null;

  const fieldKind = kindOf('field');
  const commands: Command[] = [
    ...fields.map((name): Command => (fieldKind?.enable ? fieldKind.enable(name, world) : { op: 'add_field', name })),
    ...itemCmds,
    ...(defaultStyle ? [{ op: 'set_name_style', id: defaultStyle } as Command] : []),
  ];
  return { command: { op: 'batch', label: `用上资源包“${pack.name}”`, commands }, added, skipped, fields, defaultStyle };
}

function nameOf(kind: ContentKind, item: unknown): string {
  const n = (item as { name?: unknown }).name;
  return kind.nameOf ? kind.nameOf(item) : typeof n === 'string' ? n : '';
}

// 用了之后变成新生态的格（按生态分开：主导生态是这次新加的，改了名的按新 id）。world 是用了之后的世界（确切预览算出的）
export function newBiomeCells(plan: PackPlan, after: Pick<World, 'small' | 'derived'>): Map<number, number[]> {
  const ids = new Set(plan.added.filter((a) => a.section === 'biomes').map((a) => a.id));
  const out = new Map<number, number[]>();
  if (!ids.size) return out;
  // 按生态的下标先查好（大星球上 10 万格，不在每格比字符串）
  const isNew = after.small.species.map((x) => ids.has(x.id));
  const dom = after.derived.dominant;
  for (let i = 0; i < dom.length; i++) {
    const s = dom[i];
    if (s < 0 || !isNew[s]) continue;
    let list = out.get(s);
    if (!list) out.set(s, (list = []));
    list.push(i);
  }
  return out;
}

// 资源包用到世界的命令：一整步（只加东西，不删、不改世界里已有的）
export function applyPackCommands(world: PackWorld, pack: ResourcePack, picks: PackPicks = defaultPicks(pack)): Extract<Command, { op: 'batch' }> {
  return planPack(world, pack, picks).command;
}

// ---------- 从世界导出 ----------

// 世界里有、但不能导出的（只在这个世界的某处长的）生态的个数（导出时说一句）
export function endemicCount(world: PackWorld): number {
  return world.small.species.filter((s) => !!s.dispersal || !!s.range).length;
}

// 按段名给要导出的 id（省略的段取全部能导出的）；wordPack：带上世界在用的旧文字包（换过内置中文时）
export interface WorldPicks {
  biomes?: readonly string[];
  riverTypes?: readonly string[];
  lakeTypes?: readonly string[];
  islandTypes?: readonly string[];
  planetForms?: readonly string[];
  nameStyles?: readonly string[];
  wordPack?: boolean;
  [key: string]: readonly string[] | boolean | undefined;
}

export interface PackMeta {
  id?: string;
  name: string;
  author?: string;
  description?: string;
}

// 把世界里勾选的项做成资源包。省略 picks 里的某一段时取全部能导出的；没有内容的段不写
export function packFromWorld(world: PackWorld, picks: WorldPicks, meta: PackMeta): ResourcePack {
  const pack: ResourcePack = { format: PACK_FORMAT, version: PACK_VERSION, id: meta.id ?? packIdFor(meta.name), name: meta.name };
  if (meta.author) pack.author = meta.author;
  if (meta.description) pack.description = meta.description;
  const fields = new Set<string>();
  const sections: [string, unknown[]][] = [];
  for (const k of packSections()) {
    const all = k.pack.fromWorld ? k.pack.fromWorld(world) : [];
    const ids = picks[k.pack.key];
    const chosen = Array.isArray(ids) ? all.filter((x) => ids.includes(itemId(k, x))) : all;
    const items = chosen.map((x) => (k.pack.exportItem ? k.pack.exportItem(x) : x));
    // 旧的文字包（换过内置中文时）：按模板式的地名风格带上
    if (k.pack.key === 'nameStyles' && picks.wordPack && world.small.wordPack) items.push({ ...structuredClone(world.small.wordPack), kind: 'template' });
    // 自定义场只跟着生态（与以前一样）
    if (k.pack.key === 'biomes') for (const x of items) for (const f of k.pack.fieldsOf?.(x) ?? []) fields.add(f);
    if (items.length) sections.push([k.pack.key, items]);
  }
  if (fields.size) pack.fields = [...fields];
  for (const [key, items] of sections) pack[key] = items;
  return pack;
}

// 包里的星球形态（已按格式检查过：parsePack 读出来的、内置的）
export function packForms(pack: Pick<ResourcePack, 'planetForms'>): PlanetForm[] {
  return (pack.planetForms ?? []) as unknown as PlanetForm[];
}
