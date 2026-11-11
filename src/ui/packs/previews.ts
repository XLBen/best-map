import { FLAG_EMBLEMS, FLAG_LAYOUTS, type FlagSpec, cityList, makeFlag } from '../../../core/human';
import type { World } from '../../../core/world';
import { EMBLEM_NAMES, LAYOUT_NAMES } from '../domain/flag-names';
import { type Obj, titleRows } from './fields';
import type { PageCtx, SourceRef } from './page-source';
import { refLabel, refOptionsOf } from './refs';

// 表单旁的小预览（第九十轮）：改之前就看得到会是什么样。
//   地标“名字的写法”的示例：写法里的 {city}、{country}…… 换成名字后的样子，每种写法（默认的、按文化换的）一行
//   政体的旗：按“旗上的纹章”“旗的样式”生成的几面（和生成国家时同一个函数 makeFlag）
// 国名、称号的示例留给第九十一轮。不碰界面，测试直接调

// ---------- 地标的名字 ----------

// 写法里能用的词（core/human/landmarks.ts 的 token）；不认识的词按当地的小地名
export const LANDMARK_TOKENS = ['city', 'country', 'river', 'range', 'peak', 'lake', 'place', 'culture'] as const;
// 每个词换成什么（第九十三轮：写在示例下面，不用猜英文）
export const LANDMARK_TOKEN_NAMES: Record<(typeof LANDMARK_TOKENS)[number], string> = { city: '城市', country: '国家', river: '河', range: '山脉', peak: '山峰', lake: '湖', place: '当地的小地名', culture: '文化' };
type Word = { zh: string; orig?: string };
// 没有世界（看的是库）、地图上没有这样东西时用的名字
const SAMPLE_WORDS: Record<string, Word> = {
  city: { zh: '洛安', orig: 'Loan' },
  country: { zh: '青岚', orig: 'Qinglan' },
  river: { zh: '白河', orig: 'Baihe' },
  range: { zh: '苍岭', orig: 'Cangling' },
  peak: { zh: '雪顶山', orig: 'Xueding' },
  lake: { zh: '镜湖', orig: 'Jinghu' },
  place: { zh: '河口', orig: 'Hekou' },
  culture: { zh: '山民' },
};

const TOKEN = /\{(\w+)\}/g;

// 这张地图上的名字（本世界里看时示例用真的：最大的城市、第一个国家、第一条有名字的河……）；没有的用上面的
function worldWords(w: World | null): Record<string, Word> {
  if (!w?.derived) return SAMPLE_WORDS;
  const out: Record<string, Word> = { ...SAMPLE_WORDS };
  const named = (type: string) => w.derived.features.find((f) => f.type === type && f.name);
  for (const t of ['river', 'range', 'lake'] as const) {
    const f = named(t);
    if (f) out[t] = { zh: f.name, ...(f.orig ? { orig: f.orig } : {}) };
  }
  const city = w.small.cities && Object.keys(w.small.cities).length ? cityList(w)[0] : undefined;
  if (city) out.city = { zh: city.name, ...(city.orig ? { orig: city.orig } : {}) };
  const country = Object.values(w.small.countries ?? {})[0];
  if (country) out.country = { ...country.base };
  return out;
}

export interface NameSample {
  // 哪一种写法：“默认”、文化或文化组的名字
  who: string;
  zh: string;
  orig?: string;
}

const MAX_SAMPLES = 6;

// 地标名字的示例：每种写法一行。写法空着时用类型的名字（和地图上一样）
export function landmarkSamples(item: Obj, src: SourceRef, ctx: PageCtx): NameSample[] {
  const base = worldWords(src.t === 'world' ? (ctx.world as World | null) : null);
  const fill = (zh: string, orig: string, words: Record<string, Word>): Word => {
    const word = (k: string): Word => words[k] ?? words.place;
    const out = zh.replace(TOKEN, (_, k: string) => word(k).zh);
    const keys = [...zh.matchAll(TOKEN)].map((m) => m[1]);
    // 原文：写法有原文、用到的词都有原文时才有；整个写法只是一个词时用它的原文（和 landmarks.ts 的 fill 一样）
    if (orig) return [...orig.matchAll(TOKEN)].every((m) => word(m[1]).orig) ? { zh: out, orig: orig.replace(TOKEN, (_, k: string) => word(k).orig!) } : { zh: out };
    const only = /^\{(\w+)\}$/.test(zh) && keys.length === 1 ? word(keys[0]).orig : undefined;
    return only ? { zh: out, orig: only } : { zh: out };
  };
  const rows = titleRows(item.label).filter((r) => r.zh.trim());
  const typeName = typeof item.name === 'string' ? item.name : '';
  if (!rows.length) return typeName ? [{ who: '默认', zh: typeName }] : [];
  const keyNames = refOptionsOf(['culture', 'cultureGroup'], ctx);
  return rows.slice(0, MAX_SAMPLES).map((r) => {
    const culture = r.key !== 'default' ? refLabel(keyNames, r.key) : '';
    // 按文化换的写法里 {culture} 就是这种文化
    const n = fill(r.zh.trim(), r.orig.trim(), culture ? { ...base, culture: { zh: culture } } : base);
    return { who: r.key === 'default' ? '默认' : culture || r.key, ...n };
  });
}

// ---------- 政体的旗 ----------

// 示例旗的底色（国家的颜色是生成时从文化取的，这里轮着用几种）
const FLAG_MAINS = ['#b8202a', '#1f4f9a', '#2b7a3d', '#c98a1a', '#5e2c84', '#2a7f8f'];

export interface FlagPreview {
  flags: FlagSpec[];
  // 写了但不认识的纹章、样式（不起作用）
  unknown: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// 按政体写的纹章、样式生成 n 面（seed 是“换一批”换的）。和生成国家时一样：七成用写的样式，纹章四面里约三面有
export function flagPreview(gov: Obj, seed: number, n = 6): FlagPreview {
  const emblems = strings(gov.emblems);
  const layouts = strings(gov.layouts);
  const categories = strings(gov.category);
  const flags = Array.from({ length: n }, (_, k) => makeFlag((seed * 7919 + k * 104729) >>> 0, FLAG_MAINS[(seed + k) % FLAG_MAINS.length], { categories, layouts, emblems }));
  const unknown = [...emblems.filter((e) => !(FLAG_EMBLEMS as readonly string[]).includes(e)), ...layouts.filter((l) => !(FLAG_LAYOUTS as readonly string[]).includes(l))];
  return { flags, unknown };
}

// 能写的纹章、样式（写在预览下面）
export const FLAG_WORDS = { emblems: FLAG_EMBLEMS as readonly string[], layouts: FLAG_LAYOUTS as readonly string[] };

// ---------- 旗的纹章、样式：带小图的选择（第九十三轮：以前手打 crown lion tower、bicolor-h） ----------

export type FlagPart = 'emblems' | 'layouts';
export interface FlagChoice {
  id: string;
  // 中文名（王冠、横二色）
  label: string;
  // 画出来的小图：样式是那种样式的一面旗，纹章是纯色底上的那个纹章
  flag: FlagSpec;
}

const CHOICE_COLORS = ['#1f4f9a', '#f4f1e8', '#b8202a'];
const cache = new Map<FlagPart, FlagChoice[]>();
export function flagChoices(part: FlagPart): FlagChoice[] {
  let list = cache.get(part);
  if (!list) {
    list =
      part === 'layouts'
        ? FLAG_LAYOUTS.map((id) => ({ id, label: LAYOUT_NAMES[id] ?? id, flag: { layout: id, colors: [...CHOICE_COLORS] } }))
        : FLAG_EMBLEMS.map((id) => ({ id, label: EMBLEM_NAMES[id] ?? id, flag: { layout: 'plain', colors: [CHOICE_COLORS[0]], emblem: id, emblemColor: CHOICE_COLORS[1] } }));
    cache.set(part, list);
  }
  return list;
}

// 点了一个：有就去掉，没有就加上（按那张表的先后；表里没有的照旧留在后面）。一个都没有时 undefined（这个字段可以不写）
export function toggleFlagWord(part: FlagPart, value: unknown, id: string): string[] | undefined {
  const cur = strings(value);
  const order = flagChoices(part).map((c) => c.id);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...order.filter((o) => o === id || cur.includes(o)), ...cur.filter((x) => !order.includes(x))];
  return next.length ? next : undefined;
}

// 写了但表里没有的（以前手打错的）：照旧列出来，能点掉
export const unknownFlagWords = (part: FlagPart, value: unknown): string[] => {
  const known = new Set(flagChoices(part).map((c) => c.id));
  return strings(value).filter((x) => !known.has(x));
};
