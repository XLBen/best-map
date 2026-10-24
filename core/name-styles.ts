import { z } from 'zod';
import type { FeatureOverride, GeoFeature } from './features';
import { DEFAULT_PACK, type WordPack, generateName, hashString, packProblems as templateListProblems, wordPackSchema } from './names';
import { mixSeed, mulberry32 } from './rng';
import { typeIdSchema } from './type-id';
import type { SmallState } from './world';

// 地名风格（第二十轮）：一个世界可以启用好几种，各地物、省份可以单独选。两种写法：
//   模板式（kind: 'template'）：就是原来的文字包——词表 + 每种地貌的模板；可以另带读音表 readings
//     （按最长匹配把名字逐段换成原文，如“白川”→ shirakawa），读得出整个名字时才有原文。
//   音译式（kind: 'phonetic'）：先按音节表拼出外文的词根，按地物类型套上词缀（“{root}burg”），
//     再按音译表（罗马字 → 汉字，最长匹配）写成中文：Karvilsburg → 卡尔维尔斯堡。
// 起出来的名字是 {zh, orig}：zh 上地图、进 taken 避免重名；orig 是原文（模板式没有读音表时没有）。
// 同一个种子、同一份风格，名字一字不差。

// 内置中文风格的 id：世界没选别的时用它（它的内容是 small.wordPack，没有时是内置的中文包）
export const DEFAULT_STYLE = 'zh-default';

// 带权重的一项：'k' 或 ['k', 3]（省略的权重为 1）
const weightedSchema = z.union([z.string(), z.tuple([z.string(), z.number().positive()])]);
export type Weighted = z.output<typeof weightedSchema>;

export const templateStyleSchema = wordPackSchema.extend({
  id: typeIdSchema,
  kind: z.literal('template'),
  // 读音表：汉字（一个或几个）→ 原文；按最长匹配读整个名字，读不全时没有原文
  readings: z.record(z.string().min(1), z.string()).optional(),
});

const phoneticPatternSchema = z.object({
  // 原文的写法：{root} 是拼出来的词根（{root2} 另拼一个），{表名} 换成 lists 里的一项，其余照抄
  p: z.string().min(1),
  // 中文的写法（省略时把整个原文音译）：{name} 是整个原文的音译，{root}、{表名} 是那一段的音译，
  // {__species} 是生态的名字，其余照抄（“{root}岛”）
  zh: z.string().min(1).optional(),
  w: z.number().positive().optional(),
});
const phoneticTypeSchema = z.object({
  patterns: z.array(phoneticPatternSchema).min(1),
  byTag: z.record(z.string(), z.array(phoneticPatternSchema).min(1)).optional(),
});

export const phoneticStyleSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  kind: z.literal('phonetic'),
  // 音节：声母 + 韵核 + 韵尾（'' 是没有）；first 是第一个音节的声母，last 是最后一个音节的韵尾（省略时同 onsets、codas）
  syllables: z.object({
    onsets: z.array(weightedSchema).min(1),
    nuclei: z.array(weightedSchema).min(1),
    codas: z.array(weightedSchema).min(1),
    first: z.array(weightedSchema).min(1).optional(),
    last: z.array(weightedSchema).min(1).optional(),
  }),
  // 词根几个音节：[音节数, 权重]
  length: z.array(z.tuple([z.number().int().min(1).max(6), z.number().positive()])).min(1),
  // 词缀等词表（原文），模板里写 {表名}
  lists: z.record(z.string(), z.array(weightedSchema).min(1)).optional(),
  // 不许出现的写法（小写比较）：'aa' 任何地方，'^x' 开头，'x$' 结尾。词根、整个原文都查
  forbid: z.array(z.string().min(1)).optional(),
  types: z.record(z.string(), phoneticTypeSchema),
  // 音译表：罗马字（一个或几个字母）→ 汉字；按最长匹配，辅音不和后面的元音拆开（见 transliterate）
  translit: z.record(z.string().min(1), z.string()),
  // 元音字母（省略为 aeiouy 和常见的带符号元音）
  vowels: z.string().min(1).optional(),
  // 音译表里没有的字母写成它（省略时略过）
  fallback: z.string().optional(),
});

export const nameStyleSchema = z.discriminatedUnion('kind', [templateStyleSchema, phoneticStyleSchema]);
export type TemplateStyle = z.output<typeof templateStyleSchema>;
export type PhoneticStyle = z.output<typeof phoneticStyleSchema>;
export type NameStyle = TemplateStyle | PhoneticStyle;
// 起名用的风格：内置中文与旧的文字包没有 kind（按模板式）
export type StyleBody = (WordPack & { kind?: 'template'; readings?: Record<string, string> }) | PhoneticStyle;

export interface GenName {
  zh: string;
  orig?: string;
}

export const isPhonetic = (s: StyleBody): s is PhoneticStyle => s.kind === 'phonetic';

// 风格里有没有这一类的写法
export function hasType(style: StyleBody, type: string): boolean {
  return !!style.types[type];
}

// 模板式风格本身（音译式的模板、词表不能给生态、河湖类型自带的中文模板用：退回内置的中文）
export function templateOf(style: StyleBody): WordPack & { readings?: Record<string, string> } {
  return isPhonetic(style) ? DEFAULT_PACK : style;
}

// ---------- 模板式 ----------

// 按读音表读出原文：最长匹配，读不全时没有。每个词（空格隔开）的第一个字母大写
export function readOrig(readings: Record<string, string> | undefined, zh: string): string | undefined {
  if (!readings || !zh) return undefined;
  const t = tableOf(readings);
  let out = '';
  for (let i = 0; i < zh.length; ) {
    let hit = 0;
    for (let len = Math.min(t.max, zh.length - i); len > 0; len--) {
      const r = t.map.get(zh.slice(i, i + len));
      if (r === undefined) continue;
      out += r;
      hit = len;
      break;
    }
    if (!hit) return undefined;
    i += hit;
  }
  return capitalize(out) || undefined;
}

// 模板式起名：与以前的文字包一字不差，再按读音表给原文
export function templateName(pack: WordPack & { readings?: Record<string, string> }, type: string, tags: string[], seed: number, taken?: Set<string>): GenName {
  const zh = generateName(pack, type, tags, seed, taken);
  const orig = readOrig(pack.readings, zh);
  return orig ? { zh, orig } : { zh };
}

// ---------- 音译式 ----------

interface Table {
  map: Map<string, string>;
  max: number;
}
const tables = new WeakMap<object, Table>();
function tableOf(rec: Record<string, string>, lower = false): Table {
  let t = tables.get(rec);
  if (!t) {
    const map = new Map<string, string>();
    let max = 0;
    for (const [k, v] of Object.entries(rec)) {
      const key = lower ? k.toLowerCase() : k;
      map.set(key, v);
      max = Math.max(max, key.length);
    }
    tables.set(rec, (t = { map, max }));
  }
  return t;
}

const VOWELS = 'aeiouyäöüéèêëàáâíìîóòôúùûåæø';

const wOf = (x: Weighted) => (typeof x === 'string' ? 1 : x[1]);
const sOf = (x: Weighted) => (typeof x === 'string' ? x : x[0]);
function pickW(items: readonly Weighted[], rand: () => number): string {
  let total = 0;
  for (const it of items) total += wOf(it);
  let r = rand() * total;
  for (const it of items) {
    r -= wOf(it);
    if (r <= 0) return sOf(it);
  }
  return sOf(items[items.length - 1]);
}

function pickPattern<T extends { w?: number }>(items: readonly T[], rand: () => number): T {
  let total = 0;
  for (const it of items) total += it.w ?? 1;
  let r = rand() * total;
  for (const it of items) {
    r -= it.w ?? 1;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// 不许出现的写法（小写比较）
export function forbidden(style: Pick<PhoneticStyle, 'forbid'>, s: string): boolean {
  if (!style.forbid) return false;
  const low = s.toLowerCase();
  for (const f of style.forbid) {
    const head = f.startsWith('^');
    const tail = f.endsWith('$') && f.length > 1;
    const body = f.slice(head ? 1 : 0, tail ? -1 : undefined);
    if (!body) continue;
    if (head && tail ? low === body : head ? low.startsWith(body) : tail ? low.endsWith(body) : low.includes(body)) return true;
  }
  return false;
}

// 拼一个词根：音节数按 length，每个音节 声母 + 韵核 + 韵尾；碰上不许的写法重拼（最多 24 次，之后照用）
export function makeRoot(style: PhoneticStyle, rand: () => number): string {
  const sy = style.syllables;
  const lengths = style.length.map(([n, w]) => [String(n), w] as Weighted);
  let s = '';
  for (let t = 0; t < 24; t++) {
    const n = Number(pickW(lengths, rand));
    s = '';
    for (let k = 0; k < n; k++) {
      s += pickW(k === 0 && sy.first ? sy.first : sy.onsets, rand);
      s += pickW(sy.nuclei, rand);
      s += pickW(k === n - 1 && sy.last ? sy.last : sy.codas, rand);
    }
    if (s && !forbidden(style, s)) return s;
  }
  return s;
}

// 音译：罗马字 → 汉字。从左往右取音译表里最长的一段；但一段以辅音结尾、后面紧跟元音时，
// 先试短一些的（辅音归后面的音节：vilen → vi·len 维伦，不是 vil·en 维尔恩），都不行再用它。
// 空格写成“·”，连字符、撇号略过，表里没有的字母写成 fallback（省略时略过）
export function transliterate(style: Pick<PhoneticStyle, 'translit' | 'vowels' | 'fallback'>, roman: string): string {
  const t = tableOf(style.translit, true);
  const vowels = style.vowels ?? VOWELS;
  const isV = (c: string | undefined) => c !== undefined && vowels.includes(c);
  const s = roman.toLowerCase();
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === ' ') {
      if (out && !out.endsWith('·')) out += '·';
      i++;
      continue;
    }
    if (c === '-' || c === "'" || c === '’') {
      i++;
      continue;
    }
    let best = 0;
    let fallbackLen = 0;
    for (let len = Math.min(t.max, s.length - i); len > 0; len--) {
      if (!t.map.has(s.slice(i, i + len))) continue;
      const last = s[i + len - 1];
      // 以辅音结尾、后面是元音：辅音留给后面（还有更短的可试时）
      if (len > 1 && !isV(last) && isV(s[i + len])) {
        if (!fallbackLen) fallbackLen = len;
        continue;
      }
      best = len;
      break;
    }
    if (!best) best = fallbackLen;
    if (best) {
      out += t.map.get(s.slice(i, i + best))!;
      i += best;
    } else {
      out += style.fallback ?? '';
      i++;
    }
  }
  return out.replace(/·+$/, '');
}

// 原文的大小写：每个词（空格隔开）的第一个字母大写
function capitalize(s: string): string {
  return s.replace(/(^|\s)(\p{Ll})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

interface Segment {
  text: string;
  // 模板里照抄的（不改大小写）
  literal: boolean;
  token?: string;
}

const TOKEN = /\{([^{}]+)\}/g;

// 按一个模板拼出原文与中文
function fillPhonetic(style: PhoneticStyle, pat: { p: string; zh?: string }, rand: () => number, species?: string): GenName {
  const values = new Map<string, string>();
  const valueOf = (token: string): string => {
    let v = values.get(token);
    if (v !== undefined) return v;
    if (token === '__species') v = '';
    else if (/^root\d*$/.test(token)) v = makeRoot(style, rand);
    else {
      const list = style.lists?.[token];
      v = list ? pickW(list, rand) : '';
    }
    values.set(token, v);
    return v;
  };
  const segs: Segment[] = [];
  let at = 0;
  for (const m of pat.p.matchAll(TOKEN)) {
    if (m.index > at) segs.push({ text: pat.p.slice(at, m.index), literal: true });
    segs.push({ text: valueOf(m[1]), literal: false, token: m[1] });
    at = m.index + m[0].length;
  }
  if (at < pat.p.length) segs.push({ text: pat.p.slice(at), literal: true });
  // 大小写：照抄的原样，拼出来的在词首大写
  let orig = '';
  for (const s of segs) {
    let text = s.text;
    if (!s.literal && text && (!orig || /\s$/.test(orig))) text = text[0].toUpperCase() + text.slice(1);
    orig += text;
  }
  orig = orig.replace(/\s+/g, ' ').trim();
  let zh: string;
  if (pat.zh) {
    zh = pat.zh.replace(TOKEN, (_, token: string) => {
      if (token === 'name') return transliterate(style, orig);
      if (token === '__species') return species ?? '';
      return transliterate(style, values.get(token) ?? valueOf(token));
    });
  } else zh = transliterate(style, orig);
  return { zh, orig };
}

// 音译式起名；taken 里已有的中文名字避开（换几次种子）
export function phoneticName(style: PhoneticStyle, type: string, tags: string[], seed: number, taken?: Set<string>, species?: string): GenName {
  const t = style.types[type] ?? style.types.default ?? style.types.island ?? Object.values(style.types)[0];
  if (!t) return { zh: '' };
  let last: GenName = { zh: '' };
  for (let attempt = 0; attempt < 12; attempt++) {
    const rand = mulberry32(mixSeed(seed, attempt, 0x7a11));
    const tagged = tags.flatMap((tag) => t.byTag?.[tag] ?? []);
    const pool = tagged.length && rand() < 0.65 ? tagged : t.patterns;
    const name = fillPhonetic(style, pickPattern(pool, rand), rand, species);
    last = name;
    if (attempt < 11 && (!name.zh || forbidden(style, name.orig ?? ''))) continue;
    if (!taken || !taken.has(name.zh) || attempt === 11) {
      if (name.zh) taken?.add(name.zh);
      return name;
    }
  }
  return last;
}

// 按风格起名（模板式、音译式都走这里）。species：生态区的生态名字（模板式经 __species 词表放进去，见 features.ts）
export function styleName(style: StyleBody, type: string, tags: string[], seed: number, taken?: Set<string>, species?: string): GenName {
  if (isPhonetic(style)) return phoneticName(style, type, tags, seed, taken, species);
  return templateName(style, type, tags, seed, taken);
}

// ---------- 检查 ----------

const allPatterns = (style: PhoneticStyle) => Object.entries(style.types).flatMap(([type, t]) => [...t.patterns, ...Object.values(t.byTag ?? {}).flat()].map((p) => ({ type, p })));

// 一种风格的问题（有就不能启用）：模板、写法里用到了不存在的词表
export function styleProblems(style: NameStyle): string[] {
  if (style.kind === 'template') return templateListProblems(style);
  const problems: string[] = [];
  for (const { type, p } of allPatterns(style)) {
    for (const m of p.p.matchAll(TOKEN)) {
      if (!/^root\d*$/.test(m[1]) && m[1] !== '__species' && !style.lists?.[m[1]]) problems.push(`“${type}”的写法“${p.p}”用到了不存在的词表 {${m[1]}}`);
    }
  }
  return problems;
}

// 提醒（不挡启用）：音译式的音节、词缀、写法里有音译表里一个字母也对不上的（音译时略过）
export function styleNotes(style: NameStyle): string[] {
  if (style.kind !== 'phonetic' || style.fallback !== undefined) return [];
  const t = tableOf(style.translit, true);
  const letters = new Set<string>();
  const sy = style.syllables;
  const words = [...sy.onsets, ...sy.nuclei, ...sy.codas, ...(sy.first ?? []), ...(sy.last ?? []), ...Object.values(style.lists ?? {}).flat()].map(sOf);
  for (const { p } of allPatterns(style)) words.push(p.p.replace(TOKEN, ''));
  for (const w of words) for (const c of w.toLowerCase()) if (/\p{L}/u.test(c) && !t.map.has(c)) letters.add(c);
  return letters.size ? [`音译表里没有这些字母，音译时略过：${[...letters].join(' ')}`] : [];
}

// ---------- 世界里的风格 ----------

type StyleSmall = Pick<SmallState, 'wordPack' | 'featureNames' | 'provinces'> & Partial<Pick<SmallState, 'content' | 'nameStyle'>>;

// 世界里启用的风格（不含内置中文）
export function worldStyles(small: Pick<Partial<SmallState>, 'content'>): Record<string, NameStyle> {
  return small.content?.nameStyle ?? {};
}

// 按 id 找世界里的风格：内置中文是 small.wordPack（旧的文字包），没有时是内置的中文包
export function styleById(small: StyleSmall, id: string): StyleBody | undefined {
  if (id === DEFAULT_STYLE) return small.wordPack ?? DEFAULT_PACK;
  return worldStyles(small)[id];
}

// 世界默认的风格 id（选的那种不在世界里时退回内置中文）
export function worldStyleId(small: StyleSmall): string {
  const id = small.nameStyle;
  return id && styleById(small, id) ? id : DEFAULT_STYLE;
}

// 一处地方的风格：用哪一种、起名的种子要加什么、起名的办法的标识（留着的名字按它判断还能不能用）
export interface ResolvedStyle {
  id: string;
  style: StyleBody;
  // 不是世界默认的风格时，种子后面加上 “:风格 id”（只用默认风格的世界名字一个不变）
  suffix: string;
  // 起名的办法里的风格标识：内置中文是旧的文字包标识（没有文字包时为 '-'），别的是内容的哈希
  tag: string;
}

const styleTags = new WeakMap<object, string>();
function contentTag(style: object): string {
  let t = styleTags.get(style);
  if (t === undefined) styleTags.set(style, (t = hashString(JSON.stringify(style)).toString(36)));
  return t;
}

// 要给哪一处起名：地物（override 是落到它上面的改名，见 features.ts 的 assignNames；省略时按它自己的键找）或省份
export type StyleTarget = { feature: Pick<GeoFeature, 'key'>; override?: FeatureOverride } | { province: number };

// 自己选的风格 id（没有选时 undefined）。第二十二轮在这里接上“当地文化的风格”
export function ownStyleId(small: StyleSmall, target: StyleTarget): string | undefined {
  if ('province' in target) return small.provinces[target.province]?.style;
  // 给了落到它上面的改名（起名时）就只看它，没给时按地物自己的键找
  return target.override ? target.override.style : small.featureNames[target.feature.key]?.style;
}

// 一处地方用哪种风格：自己选的 → 世界默认 → 内置中文。选的风格不在世界里了（停用了）时按世界默认
export function styleFor(world: { small: StyleSmall }, target?: StyleTarget): ResolvedStyle {
  const small = world.small;
  const def = worldStyleId(small);
  const own = target ? ownStyleId(small, target) : undefined;
  const id = own && styleById(small, own) ? own : def;
  const style = styleById(small, id)!;
  const tag = id === DEFAULT_STYLE ? (small.wordPack ? contentTag(small.wordPack) : '-') : contentTag(style);
  return { id, style, suffix: id === def ? '' : `:${id}`, tag };
}

// 世界里指向不存在的风格的地方（停用了还在用）：起名时按世界默认，这里列出来给界面提示
export function missingStyles(small: StyleSmall): { where: string; id: string }[] {
  const out: { where: string; id: string }[] = [];
  const has = (id: string) => !!styleById(small, id);
  if (small.nameStyle && !has(small.nameStyle)) out.push({ where: 'world', id: small.nameStyle });
  for (const [key, ov] of Object.entries(small.featureNames)) if (ov.style && !has(ov.style)) out.push({ where: key, id: ov.style });
  for (const [id, p] of Object.entries(small.provinces)) if (p.style && !has(p.style)) out.push({ where: `province:${id}`, id: p.style });
  return out;
}

// 风格是不是在用：世界默认、某个地物或省份选了它
export function styleInUse(small: StyleSmall, id: string): boolean {
  if ((small.nameStyle ?? DEFAULT_STYLE) === id) return true;
  for (const ov of Object.values(small.featureNames)) if (ov.style === id) return true;
  for (const p of Object.values(small.provinces)) if (p.style === id) return true;
  return false;
}

// 预览：按风格随便起几个名字（编辑器里的随机示例）
export function sampleNames(style: StyleBody, type: string, count: number, seed = 1): GenName[] {
  const taken = new Set<string>();
  return Array.from({ length: count }, (_, k) => styleName(style, type, [], hashString(`sample:${seed}:${type}:${k}`), taken));
}
