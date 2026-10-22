import { z } from 'zod';
import zhCN from 'zod/v4/locales/zh-CN.js';
import type { Command } from './commands';
import { DEFAULT_PACK, type WordPack, packProblems as wordPackProblems, wordPackSchema } from './names';
import { type PlanetForm, planetFormSchema } from './planet-form';
import { type FoundScript, VARIABLES, codeOnly, findScripts } from './script';
import { DEFAULT_SPECIES, type Species, speciesSchema } from './species';
import type { World } from './world';

// 资源包（第三批，*.map2pack.json）：几种生态、河流类型、星球形态、文字包放在一个文件里，导入、导出、用到世界。
//
//   {format: 'map2-pack', version: 1, id, name, author?, description?, fields?, biomes?, riverTypes?, planetForms?, textPacks?}
//
// 顶层严格：不认识的部分直接报错（“不认识的部分：xxx”），不悄悄丢掉。读包只做解析与检查，不运行任何脚本。
// 用到世界是一整步（一个 batch，可撤销）：先加用到的自定义场，再加各项；世界里已有一模一样的项跳过，
// 同 id 不同内容的改名为 “id-2”，包里对它的引用（侵占的目标、river('x')）一起改；噪声种子用固定的 seedKey，改名不改花纹。
// 世界自带它用到的全部内容（都在命令里），别人没有这个包也能打开。
//
// 河流类型由另一支做：这里先按“带 id 的对象”收下（原样保留），它的校验、用到世界的命令、
// 从世界导出、改名，由那一支在 registerPackSection 里填上（见 PACK_SECTIONS）。
// 星球形态在本文件末尾注册：按 planet-form.ts 的格式逐项检查，导出时带上世界在用的形态；
// 不在“用到这个世界”里用（在 调整 → 星球形态 里换，或新建世界时选）。

export const PACK_FORMAT = 'map2-pack';
export const PACK_VERSION = 1;
export const PACK_EXT = '.map2pack.json';
// 生态多了界面挤、算得慢：超过这么多种时提醒一句（不拦）
export const SPECIES_SOFT_CAP = 48;
// 一个文件里最多这么多项（再多就不像是资源包了：一下子加几百种生态，大星球上会算不动）
export const PACK_MAX = { biomes: 256, riverTypes: 64, planetForms: 32, textPacks: 16 } as const;
// 文件最多这么多字（脚本最长 2 万字，256 种生态各两段也到不了）
export const PACK_MAX_CHARS = 16_000_000;

const ITEM_ID = /^[\w-]+$/;
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #rrggbb');
const fieldName = z.string().regex(ITEM_ID, '场名只能包含字母、数字、下划线和连字符');

// ---------- 河流类型、星球形态：可插拔的部分 ----------

export type PackSectionKey = 'riverTypes' | 'planetForms';
export type PackWorld = Pick<World, 'small' | 'causes'>;

// 每一项至少是带 id 的对象（名字、颜色可选，其余原样保留）
export interface PackItem {
  id: string;
  name?: string;
  color?: string;
  [k: string]: unknown;
}

export interface PackSection {
  // 列表里的叫法：“河流 4”“星球 3”
  label: string;
  // 每一项的校验。那一支注册之前只要求是带 id 的对象
  schema: z.ZodType<PackItem>;
  // 用到这个世界时默认勾上
  checked: boolean;
  // 不能直接用到世界时的说明（列出来，不能勾）
  note?: string;
  // 世界里已有的同类项（撞 id 时比较是不是一模一样）
  inWorld?(world: PackWorld): readonly PackItem[];
  // 用到世界的命令（每项一条）。没有时这一类只列出来
  command?(item: PackItem): Command;
  // 换 id（撞 id 改名时）：种子要用原来的，花纹才不变
  withId?(item: PackItem, id: string, from: string): PackItem;
  // 从世界导出的项（只要不是内置的）
  fromWorld?(world: PackWorld): PackItem[];
  // 包里别的项改了名时，这一项里的引用跟着改（比如河流类型的脚本里 field('x')）
  rewrite?(item: PackItem, renames: Renames): PackItem;
}

const plainItem = z.looseObject({
  id: z.string().regex(ITEM_ID, 'id 只能包含字母、数字、下划线和连字符'),
  name: z.string().optional(),
  color: hexColor.optional(),
}) as unknown as z.ZodType<PackItem>;

// TODO(河流类型那一支)：registerPackSection('riverTypes', {schema, inWorld, command: set_river_type, withId, fromWorld, rewrite})
// 星球形态的校验、导出在本文件末尾注册（见 registerPackSection('planetForms', …)）；它不在这里用到世界（调整 → 星球形态）
export const PACK_SECTIONS: Record<PackSectionKey, PackSection> = {
  riverTypes: { label: '河流', schema: plainItem, checked: true, note: '这一版还不能用河流类型' },
  planetForms: { label: '星球', schema: plainItem, checked: false, note: '星球形态在 调整 → 星球形态 里换，或新建世界时选' },
};

export function registerPackSection(key: PackSectionKey, def: Partial<PackSection>): void {
  const cur = PACK_SECTIONS[key];
  // 能用到世界了：去掉“还不能用”的说明（除非另给）
  PACK_SECTIONS[key] = { ...cur, ...(def.command && !('note' in def) ? { note: undefined } : {}), ...def };
}

// ---------- 格式 ----------

// 顶层的结构（严格）；河流类型、星球形态在 parsePack 里按注册的校验逐项再查
export const resourcePackSchema = z.strictObject({
  format: z.literal(PACK_FORMAT),
  version: z.literal(PACK_VERSION),
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  author: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  fields: z.array(fieldName).max(64).optional(),
  biomes: z.array(speciesSchema).max(PACK_MAX.biomes).optional(),
  riverTypes: z.array(z.unknown()).max(PACK_MAX.riverTypes).optional(),
  planetForms: z.array(z.unknown()).max(PACK_MAX.planetForms).optional(),
  textPacks: z.array(wordPackSchema).max(PACK_MAX.textPacks).optional(),
});

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
  planetForms?: PackItem[];
  textPacks?: WordPack[];
}

// 出错说明：顶层多出来的部分说“不认识的部分”，类型不对、缺项用中文说，其余用 zod 的中文
const zh = zhCN().localeError;
const TYPE_ZH: Record<string, string> = { string: '文字', number: '数', boolean: '是或否', array: '列表', object: '一组设置' };
const packErrorMap: z.core.$ZodErrorMap = (iss) => {
  if (iss.code === 'unrecognized_keys') return `${iss.path?.length ? '不认识的项' : '不认识的部分'}：${iss.keys.join('、')}`;
  if (iss.code === 'invalid_type') return iss.input === undefined ? '缺少这一项' : `应该是${TYPE_ZH[iss.expected] ?? iss.expected}`;
  if (iss.code === 'invalid_value' && iss.path?.length === 1 && iss.path[0] === 'version') return `这个资源包是第 ${String(iss.input)} 版的格式，这里只认第 ${PACK_VERSION} 版`;
  // 长短、多少：说人话（zod 的中文是“数值过小：期望 string >=1 字符”）
  if (iss.code === 'too_small' && iss.origin === 'string') return Number(iss.minimum) <= 1 ? '不能是空的' : `太短了，至少 ${String(iss.minimum)} 个字`;
  if (iss.code === 'too_big' && iss.origin === 'string') return `太长了，最多 ${String(iss.maximum)} 个字`;
  if (iss.code === 'too_big' && iss.origin === 'array') return `太多了，最多 ${String(iss.maximum)} 个`;
  return zh(iss);
};

const SECTION_ZH: Record<string, string> = { biomes: '生态', riverTypes: '河流类型', planetForms: '星球形态', textPacks: '文字包', fields: '自定义场' };
const TOP_ZH: Record<string, string> = { format: '格式', id: '资源包的 id', name: '资源包的名字', author: '作者', description: '说明' };

// 出错的位置：“生态第 2 个「crystal」的 color”
function where(path: readonly PropertyKey[], json: unknown): string {
  if (!path.length) return '';
  const [head, idx, ...rest] = path;
  // 版本不对的说明本身就说清楚了
  if (path.length === 1 && head === 'version') return '';
  const sec = SECTION_ZH[String(head)];
  // 整个部分的问题（比如生态太多）
  if (sec && path.length === 1) return sec;
  if (!sec || typeof idx !== 'number') return path.length === 1 && TOP_ZH[String(head)] ? TOP_ZH[String(head)] : path.map(String).join('.');
  const raw = (json as Record<string, unknown[]>)[String(head)]?.[idx] as { id?: unknown; name?: unknown } | undefined;
  const label = typeof raw?.name === 'string' && raw.name ? raw.name : typeof raw?.id === 'string' ? raw.id : '';
  return `${sec}第 ${idx + 1} 个${label ? `「${label}」` : ''}${rest.length ? `的 ${rest.map(String).join('.')}` : ''}`;
}

function issuesText(issues: readonly z.core.$ZodIssue[], json: unknown, prefix: PropertyKey[] = []): string[] {
  return issues.map((i) => {
    const at = where([...prefix, ...i.path], json);
    return at ? `${at}：${i.message}` : i.message;
  });
}

export type PackParse = { ok: true; pack: ResourcePack } | { ok: false; errors: string[] };

// 校验一个资源包（已经是 JSON 值）。只解析、检查，不运行脚本
export function parsePack(json: unknown): PackParse {
  const top = resourcePackSchema.safeParse(json, { error: packErrorMap });
  if (!top.success) return { ok: false, errors: issuesText(top.error.issues, json) };
  const pack = top.data as ResourcePack;
  const errors: string[] = [];
  for (const key of ['riverTypes', 'planetForms'] as const) {
    const list = top.data[key];
    if (!list) continue;
    const parsed: PackItem[] = [];
    list.forEach((item, k) => {
      const r = PACK_SECTIONS[key].schema.safeParse(item, { error: packErrorMap });
      if (r.success) parsed.push(r.data);
      else errors.push(...issuesText(r.error.issues, json, [key, k]));
    });
    pack[key] = parsed;
  }
  return errors.length ? { ok: false, errors } : { ok: true, pack };
}

// 从文件读出来：资源包，或者旧的格式——生态数组（以前“生态 → 导出”的文件）、文字包。
// 都转成资源包，走同一条检查、信任的路。legacy 说明原来是什么（界面按原来的意思用：旧的生态文件是整套换掉）
export type PackRead = { ok: true; pack: ResourcePack; legacy: 'biomes' | 'wordPack' | null } | { ok: false; errors: string[] };

// name：旧的生态文件没有名字，用这个（一般是文件名）
export function readPack(text: string, name = '生态'): PackRead {
  if (text.length > PACK_MAX_CHARS) return { ok: false, errors: [`文件太大（超过 ${Math.round(PACK_MAX_CHARS / 1e6)} MB），不像是资源包`] };
  let json: unknown;
  try {
    // 记事本存的 UTF-8 文件开头可能带一个看不见的 BOM
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
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
    if (o.format === undefined && 'lists' in o && 'types' in o) {
      // 文字包：包一层，按资源包整个查一遍（资源包的名字、id 有长短限制，文字包的没有：太长的截短，存进资源库后才列得出来）
      const label = (typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '') || '文字包';
      const wrapped = { format: PACK_FORMAT, version: PACK_VERSION, id: packIdFor(typeof o.id === 'string' ? o.id : label), name: label, textPacks: [json] };
      const r = parsePack(wrapped);
      return r.ok ? { ...r, legacy: 'wordPack' } : r;
    }
  }
  return { ok: false, errors: ['不认识这个文件：不是资源包，也不是生态或文字包'] };
}

// ---------- 内容 ----------

export interface PackCounts {
  biomes: number;
  riverTypes: number;
  planetForms: number;
  textPacks: number;
}

export function packCounts(pack: ResourcePack): PackCounts {
  return { biomes: pack.biomes?.length ?? 0, riverTypes: pack.riverTypes?.length ?? 0, planetForms: pack.planetForms?.length ?? 0, textPacks: pack.textPacks?.length ?? 0 };
}

// 列表里的一行：“生态 5 · 河流 4 · 星球 3”（数从数据来，没有的不写）
export function packSummary(pack: ResourcePack): string {
  const c = packCounts(pack);
  const parts: string[] = [];
  if (c.biomes) parts.push(`生态 ${c.biomes}`);
  if (c.riverTypes) parts.push(`${PACK_SECTIONS.riverTypes.label} ${c.riverTypes}`);
  if (c.planetForms) parts.push(`${PACK_SECTIONS.planetForms.label} ${c.planetForms}`);
  if (c.textPacks) parts.push(`文字包 ${c.textPacks}`);
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

// 键排好序的 JSON：比较两项是不是一模一样（键的顺序不算）
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

export function sameItem(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

// 包里（或一条命令里、任意 JSON 里）的全部脚本：信任检查、“查看脚本”用
export function packScripts(json: unknown): FoundScript[] {
  return findScripts(json);
}

// ---------- 脚本里的引用：field('x')、river('x') ----------

const VAR_NAMES = new Set(VARIABLES.flatMap((v) => (v.zh ? [v.key, v.zh] : [v.key])));
const CALL_RE = /(?<![\p{L}\p{N}_$.])(field|river)\s*\(/gu;

interface Ref {
  fn: 'field' | 'river';
  name: string;
  // 名字在源码里的位置（不含引号）
  start: number;
  end: number;
}

// 源码里 field('x')、river('x') 的字面量参数（只看代码，注释里的不算；参数不是字面量的找不到，不报）
export function scriptRefs(src: string): Ref[] {
  const code = codeOnly(src);
  const out: Ref[] = [];
  for (const m of code.matchAll(CALL_RE)) {
    let at = m.index + m[0].length;
    while (at < src.length && /\s/.test(src[at])) at++;
    const q = src[at];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    const end = src.indexOf(q, at + 1);
    if (end < 0) continue;
    const name = src.slice(at + 1, end);
    if (name.includes('${') || name.includes('\n')) continue;
    out.push({ fn: m[1] as Ref['fn'], name, start: at + 1, end });
  }
  return out;
}

// 一种生态写到的自定义场的名字：耐受条件里的 field:x，脚本里的 field('x')（内置变量的名字不算）。可能有不合规的名字
function fieldRefs(sp: Species): string[] {
  const out = new Set<string>();
  for (const t of sp.tolerances) if (t.field.startsWith('field:')) out.add(t.field.slice(6));
  for (const s of Object.values(sp.scripts ?? {})) {
    if (!s) continue;
    for (const r of scriptRefs(s.src)) if (r.fn === 'field' && !VAR_NAMES.has(r.name)) out.add(r.name);
  }
  return [...out];
}

// 一种生态用到的自定义场（只算合规的名字：别的名字世界里不会有这个场，加也加不了，脚本照“出错”处理）
export function biomeFields(sp: Species): string[] {
  return fieldRefs(sp).filter((f) => ITEM_ID.test(f));
}

// 一种生态的脚本里用到的河流类型
export function biomeRivers(sp: Species): string[] {
  const out = new Set<string>();
  for (const s of Object.values(sp.scripts ?? {})) if (s) for (const r of scriptRefs(s.src)) if (r.fn === 'river') out.add(r.name);
  return [...out];
}

// 改名表：包里的 id → 用到世界时的 id
export interface Renames {
  biomes: ReadonlyMap<string, string>;
  riverTypes: ReadonlyMap<string, string>;
}

// 把源码里 river('旧') 换成 river('新')（只换代码里的字面量）
export function rewriteRiverRefs(src: string, rivers: ReadonlyMap<string, string>): string {
  if (!rivers.size) return src;
  let out = src;
  for (const r of scriptRefs(src).reverse()) {
    const to = r.fn === 'river' ? rivers.get(r.name) : undefined;
    if (to !== undefined && to !== r.name) out = out.slice(0, r.start) + to + out.slice(r.end);
  }
  return out;
}

// 生态里的引用跟着改名：侵占的目标、脚本里的 river('x')
function rewriteBiome(sp: Species, renames: Renames): Species {
  let out = sp;
  const inv = sp.effects?.invade;
  if (inv && inv.targets.some((t) => (renames.biomes.get(t) ?? t) !== t)) {
    out = { ...out, effects: { ...out.effects, invade: { ...inv, targets: inv.targets.map((t) => renames.biomes.get(t) ?? t) } } };
  }
  if (sp.scripts && renames.riverTypes.size) {
    const scripts = Object.fromEntries(Object.entries(sp.scripts).map(([k, s]) => [k, s && { ...s, src: rewriteRiverRefs(s.src, renames.riverTypes) }]));
    if (stableJson(scripts) !== stableJson(sp.scripts)) out = { ...out, scripts };
  }
  return out;
}

// 换 id：种子用原来的（省略 seedKey 时种子就是 id），改了名花纹也不变。
// 名字也跟着带上编号（“水晶丛林 2”）：世界里那份不一样的同名生态还在，列表里才分得清
function biomeWithId(sp: Species, id: string, from: string): Species {
  if (id === from) return sp;
  const k = id.startsWith(`${from}-`) ? id.slice(from.length + 1) : '';
  return { ...sp, id, ...(sp.name && k ? { name: `${sp.name} ${k}` } : {}), seedKey: sp.seedKey ?? from };
}

// ---------- 检查 ----------

// 包里的问题（不挡导入，列出来给用户看）：重复的 id、指向不存在的东西的引用、文字包里不存在的词表、生态太多……
export function packProblems(pack: ResourcePack): string[] {
  const problems: string[] = [];
  const dupes = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`有两个${label}的 id 都是 ${id}`);
      seen.add(id);
    }
  };
  const biomes = pack.biomes ?? [];
  dupes('生态', biomes.map((b) => b.id));
  dupes('河流类型', (pack.riverTypes ?? []).map((r) => r.id));
  dupes('星球形态', (pack.planetForms ?? []).map((r) => r.id));
  dupes('文字包', (pack.textPacks ?? []).map((t) => t.id));
  if (biomes.length > SPECIES_SOFT_CAP) problems.push(`生态有 ${biomes.length} 种：超过 ${SPECIES_SOFT_CAP} 种时界面会很挤，计算也会变慢`);

  const known = new Set([...biomes.map((b) => b.id), ...DEFAULT_SPECIES.map((b) => b.id)]);
  const fields = new Set(pack.fields ?? []);
  const rivers = new Set((pack.riverTypes ?? []).map((r) => r.id));
  const lists = new Set([...Object.keys(DEFAULT_PACK.lists), ...(pack.textPacks ?? []).flatMap((t) => Object.keys(t.lists)), '__species']);
  for (const b of biomes) {
    const who = `「${b.name || b.id}」`;
    for (const t of b.effects?.invade?.targets ?? []) if (!known.has(t)) problems.push(`${who}侵占的 ${t} 不在这个资源包里，也不是内置的生态：世界里没有它时不起作用`);
    for (const f of fieldRefs(b)) {
      if (!ITEM_ID.test(f)) problems.push(`${who}用到了自定义场「${f}」：场名只能用字母、数字、下划线和连字符，世界里不会有这个场`);
      else if (!fields.has(f)) problems.push(`${who}用到了自定义场 ${f}，资源包里没有写这个场（用的时候会新加一个空的）`);
    }
    for (const r of biomeRivers(b)) if (!rivers.has(r)) problems.push(`${who}用到了河流类型 ${r}，资源包里没有：没有这种河时按离得很远算`);
    for (const n of b.feature?.names ?? []) {
      for (const m of n.p.matchAll(/\{([^{}]+)\}/g)) if (!lists.has(m[1])) problems.push(`${who}的起名模板“${n.p}”用到了不存在的词表 {${m[1]}}`);
    }
    if (b.dispersal) problems.push(`${who}只在起源地附近长：起源地的格编号只对做它的那个世界有效`);
  }
  for (const t of pack.textPacks ?? []) problems.push(...wordPackProblems(t).map((p) => `文字包「${t.name}」：${p}`));
  return problems;
}

// ---------- 用到世界 ----------

// 要用哪些项：生态、河流类型的 id；文字包的 id（换用它），null 或省略为不换
export interface PackPicks {
  biomes?: readonly string[];
  riverTypes?: readonly string[];
  textPack?: string | null;
}

// 默认勾选：生态、能用的河流类型都勾上，文字包不勾。岛上特有的生态不勾（起源地的格编号只对做它的那个世界有效，
// 以前导出的整套生态文件里会有）
export function defaultPicks(pack: ResourcePack): PackPicks {
  return {
    biomes: (pack.biomes ?? []).filter((b) => !b.dispersal).map((b) => b.id),
    riverTypes: PACK_SECTIONS.riverTypes.command && PACK_SECTIONS.riverTypes.checked ? (pack.riverTypes ?? []).map((r) => r.id) : [],
    textPack: null,
  };
}

export type PackSectionName = 'biomes' | 'riverTypes';

export interface PackPlan {
  command: Extract<Command, { op: 'batch' }>;
  // 新加进世界的项（from 是包里的 id，id 是世界里的；改了名的两者不同）
  added: { section: PackSectionName; from: string; id: string; name: string }[];
  // 世界里已有一模一样的，跳过（id 是世界里那一项的）
  skipped: { section: PackSectionName; from: string; id: string; name: string }[];
  // 新加的自定义场
  fields: string[];
  // 换用的文字包（世界里已经是它时为 null）
  textPack: WordPack | null;
}

// 给包里的一类项定下用到世界时的 id：没有冲突的照旧；世界里有一模一样的跳过（引用指向世界里那一项）；
// 同 id 不同内容的改名为 id-2、id-3……（跳过也看改了名的那一项：同一个包用两次，第二次全部跳过）
function assignIds<T extends { id: string }>(
  items: readonly T[],
  worldItems: readonly { id: string }[],
  finalOf: (item: T, id: string) => unknown,
): { ids: Map<string, string>; skip: Set<string> } {
  const byId = new Map(worldItems.map((x) => [x.id, x]));
  const ids = new Map<string, string>();
  const skip = new Set<string>();
  // 包里自己的 id 先占上（不用改名的那些），改名时避开
  const taken = new Set([...byId.keys(), ...items.filter((x) => !byId.has(x.id)).map((x) => x.id)]);
  for (const item of items) {
    if (!byId.has(item.id)) {
      ids.set(item.id, item.id);
      continue;
    }
    for (let k = 1; ; k++) {
      const cand = k === 1 ? item.id : `${item.id}-${k}`;
      const there = byId.get(cand);
      if (there && sameItem(there, finalOf(item, cand))) {
        ids.set(item.id, cand);
        skip.add(item.id);
        break;
      }
      if (k > 1 && !there && !taken.has(cand)) {
        ids.set(item.id, cand);
        taken.add(cand);
        break;
      }
    }
  }
  return { ids, skip };
}

// 资源包用到世界的计划：一整步（batch，标签“用了资源包「X」”）
// 同一个 id 在包里出现几次时只用第一个（packProblems 会提醒）
function firstOfEach<T extends { id: string }>(items: readonly T[], ids: readonly string[] | undefined): T[] {
  const seen = new Set<string>();
  return items.filter((x) => ids?.includes(x.id) && !seen.has(x.id) && (seen.add(x.id), true));
}

export function planPack(world: PackWorld, pack: ResourcePack, picks: PackPicks): PackPlan {
  const pickedBiomes = firstOfEach(pack.biomes ?? [], picks.biomes);
  const riverSec = PACK_SECTIONS.riverTypes;
  const pickedRivers = riverSec.command ? firstOfEach(pack.riverTypes ?? [], picks.riverTypes) : [];
  const worldRivers = riverSec.inWorld?.(world) ?? [];

  // 改名表要一起定：生态 A 侵占生态 B 时，A 是不是一模一样还要看 B 改没改名。反复几遍直到不再变
  let renames: Renames = { biomes: new Map(), riverTypes: new Map() };
  let biomeIds = { ids: new Map<string, string>(), skip: new Set<string>() };
  let riverIds = { ids: new Map<string, string>(), skip: new Set<string>() };
  const finalBiome = (b: Species, id: string, r: Renames) => biomeWithId(rewriteBiome(b, r), id, b.id);
  const finalRiver = (x: PackItem, id: string, r: Renames) => {
    const re = riverSec.rewrite ? riverSec.rewrite(x, r) : x;
    return id === x.id ? re : riverSec.withId ? riverSec.withId(re, id, x.id) : { ...re, id };
  };
  for (let round = 0; round < 6; round++) {
    biomeIds = assignIds(pickedBiomes, world.small.species, (b, id) => finalBiome(b, id, renames));
    riverIds = assignIds(pickedRivers, worldRivers, (x, id) => finalRiver(x, id, renames));
    const next: Renames = { biomes: biomeIds.ids, riverTypes: riverIds.ids };
    if (stableJson([...next.biomes, ...next.riverTypes]) === stableJson([...renames.biomes, ...renames.riverTypes])) break;
    renames = next;
  }
  renames = { biomes: biomeIds.ids, riverTypes: riverIds.ids };

  const added: PackPlan['added'] = [];
  const skipped: PackPlan['skipped'] = [];
  const species: Species[] = [];
  for (const b of pickedBiomes) {
    const id = biomeIds.ids.get(b.id)!;
    if (biomeIds.skip.has(b.id)) skipped.push({ section: 'biomes', from: b.id, id, name: b.name || b.id });
    else {
      const sp = finalBiome(b, id, renames);
      species.push(sp);
      // 名字是加进世界后的（改了名的带编号）
      added.push({ section: 'biomes', from: b.id, id, name: sp.name || id });
    }
  }
  const riverCmds: Command[] = [];
  for (const x of pickedRivers) {
    const id = riverIds.ids.get(x.id)!;
    const entry = { section: 'riverTypes' as const, from: x.id, id, name: x.name || x.id };
    if (riverIds.skip.has(x.id)) skipped.push(entry);
    else {
      riverCmds.push(riverSec.command!(finalRiver(x, id, renames)));
      added.push(entry);
    }
  }

  // 新加的生态用到、世界里还没有的自定义场
  const have = new Set(Object.keys(world.causes.fields));
  const fields: string[] = [];
  for (const sp of species) for (const f of biomeFields(sp)) if (!have.has(f) && !fields.includes(f)) fields.push(f);

  const wanted = picks.textPack ? (pack.textPacks ?? []).find((t) => t.id === picks.textPack) : undefined;
  const textPack = wanted && !sameItem(wanted, world.small.wordPack) ? wanted : null;

  const commands: Command[] = [
    ...fields.map((name): Command => ({ op: 'add_field', name })),
    ...riverCmds,
    ...species.map((sp): Command => ({ op: 'add_species', species: sp })),
    ...(textPack ? [{ op: 'set_word_pack', pack: textPack } as Command] : []),
  ];
  return { command: { op: 'batch', label: `用了资源包「${pack.name}」`, commands }, added, skipped, fields, textPack };
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

// 世界里能导出的生态：不是内置的原样（内置的改过也算），也不是岛上特有的（只在那个岛上长，换个世界没有意义）
export function exportableBiomes(world: PackWorld): Species[] {
  const builtin = new Map(DEFAULT_SPECIES.map((s) => [s.id, s]));
  return world.small.species.filter((s) => !s.dispersal && !(builtin.has(s.id) && sameItem(builtin.get(s.id), s)));
}

// 世界里有、但不能导出的岛上特有生态的个数（导出时说一句）
export function endemicCount(world: PackWorld): number {
  return world.small.species.filter((s) => !!s.dispersal).length;
}

export interface WorldPicks {
  biomes?: readonly string[];
  riverTypes?: readonly string[];
  planetForms?: readonly string[];
  // 带上世界在用的文字包（不是内置的时）
  wordPack?: boolean;
}

export interface PackMeta {
  id?: string;
  name: string;
  author?: string;
  description?: string;
}

// 把世界里勾选的项做成资源包。省略 picks 里的某一类时取全部能导出的；没有内容的部分不写
export function packFromWorld(world: PackWorld, picks: WorldPicks, meta: PackMeta): ResourcePack {
  const pick = <T extends { id: string }>(all: readonly T[], ids: readonly string[] | undefined) => (ids ? all.filter((x) => ids.includes(x.id)) : [...all]);
  const biomes = pick(exportableBiomes(world), picks.biomes).map((s) => structuredClone(s));
  const fields = [...new Set(biomes.flatMap(biomeFields))];
  const riverTypes = pick(PACK_SECTIONS.riverTypes.fromWorld?.(world) ?? [], picks.riverTypes);
  const planetForms = pick(PACK_SECTIONS.planetForms.fromWorld?.(world) ?? [], picks.planetForms);
  const wp = world.small.wordPack;
  const pack: ResourcePack = { format: PACK_FORMAT, version: PACK_VERSION, id: meta.id ?? packIdFor(meta.name), name: meta.name };
  if (meta.author) pack.author = meta.author;
  if (meta.description) pack.description = meta.description;
  if (fields.length) pack.fields = fields;
  if (biomes.length) pack.biomes = biomes;
  if (riverTypes.length) pack.riverTypes = riverTypes.map((x) => structuredClone(x));
  if (planetForms.length) pack.planetForms = planetForms.map((x) => structuredClone(x));
  if (picks.wordPack && wp) pack.textPacks = [structuredClone(wp)];
  return pack;
}

// ---------- 星球形态 ----------

// 星球形态：每一项按 planet-form.ts 的格式检查（id、名字、从哪种星球改起、配方、脚本……）；
// 用到世界不经过资源包的“用到这个世界”（命令是 set_worldgen 的 params.form：在 调整 → 星球形态 里换，或新建世界时选），
// 所以不给 command，那条说明留着。从世界导出时带上世界在用的那一个
registerPackSection('planetForms', {
  schema: planetFormSchema as unknown as z.ZodType<PackItem>,
  fromWorld: (w) => {
    // 只有生态、场的小世界（测试、旧的调用方）没有 terrain
    const form = w.small.terrain?.gen?.form;
    return form ? [form as unknown as PackItem] : [];
  },
});

// 包里的星球形态（已按格式检查过：parsePack 读出来的、内置的）
export function packForms(pack: Pick<ResourcePack, 'planetForms'>): PlanetForm[] {
  return (pack.planetForms ?? []) as unknown as PlanetForm[];
}
