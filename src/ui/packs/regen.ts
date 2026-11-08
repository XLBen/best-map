import type { Command } from '../../../core/commands';
import { stableJson } from '../../../core/content/refs';
import type { Culture, Dimension, Era } from '../../../core/human/era';
import type { SmallState } from '../../../core/world';
import { type ProvinceRules, provinceSeed, worldProvinceRules } from '../../../core/province-rules';
import type { LibraryEntry } from '../../library';
import type { Content, RegenBase, RegenScope } from '../../regen-track';
import { beyondGroupIds, regenerateCommand, withPackImports } from '../domain/human';
import { worldLibrary } from '../domain/packChoice';
import { REGEN_KEEPS_ARCHIVE } from './copy';

// 面板底下的“改了 N 项 · 重新生成”（第六十二轮在顶上，第八十一轮挪到底下、省份划分也算）：内容改了、地图还没用上时才出现。和上一次生成时的内容比（regen-track.ts 记着），
// 所以撤销掉改动就没了，就地展开的项、世界里别处改的都算（比的是世界，不是这一页）。
//
// 什么算“确实需要”：
//   新加的、改过的算；移出的不算（在用的移不出，没用到的移出之后地图不变，清理不该让按钮出现）。
//   只差说明和颜色的不算：地图按现在的颜色画，不用重新生成。国家的颜色、旗子是生成时从文化取的，不跟着变，只为这个不值得重算一遍地图
//   （测试查着：改了之后重新生成，只差国家的颜色、旗子）。
//   文化组的比重只看是不是 0（别的数和没写一样）；比重 0、没选的组和它的文化不算（生成不用它们）。
//   别的时代不算；世界后加的变量和它的取值不算（只算新变量，文化、国家都不变，第五十四轮）。
//   生成了才算：没有人文时不算，没有国家时政体不算，没有城市时城市等级不算。
//
// 一个按钮，只做一步（能撤销）：
//   文化、时代、取值改了        重新生成人文（国家的领土不动）；时代里管国家的几项改了，连国家一起
//   政体、派系、国家等级改了    重新生成国家（人口按新的国家重算，锁定的不动）
//   两样都改了                  重新生成人文和国家
//   只有城市等级、地标、点改了  重新生成城市（锁定的、自己放的不动）
//   省份划分改了（第八十一轮）  按世界的种子重新划分省份（同“省份 ⋯”的划分省份；“湖”改了马上整理，不算）
// 人文、国家重新生成时城市跟着重算，所以这时不用另外一步；省份和别的一起时一个 batch，先划分省份。
// 条上写会重做什么（第八十五轮：有国家时加一句“手写的档案留着”）；上次生成之后手改过的国家、省份会被换掉时另写一句（regen-track.ts 记着 hand）

type Small = Pick<SmallState, 'content' | 'human' | 'settlementRules'> & Partial<Pick<SmallState, 'provinces'>>;
type Store = Record<string, Record<string, unknown>>;

const HUMAN: readonly string[] = ['era', 'popValue', 'valueGroup', 'cultureGroup', 'culture'];
const GOV: readonly string[] = ['government', 'faction', 'countryTier', 'countryPattern'];
const SETTLE: readonly string[] = ['cityRank', 'landmarkType', 'pointType'];

// 比较用的字：不看说明和颜色。按对象记（内容不改动）
const COSMETIC = new Set(['description', 'color']);
const keys = new WeakMap<object, string>();
function genKey(x: Record<string, unknown>): string {
  let s = keys.get(x);
  if (s === undefined) {
    s = stableJson(Object.fromEntries(Object.entries(x).filter(([k]) => !COSMETIC.has(k))));
    keys.set(x, s);
  }
  return s;
}

const storeOf = (content: Content, kind: string): Store[string] => ((content as Store | undefined)?.[kind] ?? {}) as Store[string];

// 这一种里新加的、改过的 id
function changedIds(base: Content, now: Content, kind: string, same: (x: Record<string, unknown>, y: Record<string, unknown>) => boolean = (x, y) => genKey(x) === genKey(y)): string[] {
  const a = storeOf(base, kind);
  const b = storeOf(now, kind);
  if (a === b) return [];
  const out: string[] = [];
  for (const id of Object.keys(b)) {
    const y = b[id] as Record<string, unknown>;
    const x = a[id] as Record<string, unknown> | undefined;
    if (x === y) continue;
    if (!x || !same(x, y)) out.push(id);
  }
  return out;
}

function humanChanges(small: Small, base: Content, lib: readonly LibraryEntry[]): string[] {
  const h = small.human;
  if (!h) return [];
  const eraId = h.era;
  const eraNow = storeOf(small.content, 'era')[eraId] as Era | undefined;
  const eraThen = storeOf(base, 'era')[eraId] as Era | undefined;
  const dims = new Set((eraNow?.dimensions ?? []).map((d) => d.id));
  const had = new Set((eraThen?.dimensions ?? []).map((d) => d.id));
  // 世界后加的变量（生成之后才有的）
  const fresh = (dim: unknown) => dims.has(String(dim)) && !had.has(String(dim)) && !!eraThen;
  const out: string[] = [];
  // 时代：只看用着的那一个，后加的变量不算
  if (eraNow && eraThen && eraNow !== eraThen) {
    const bare = (e: Era) => genKey({ ...e, dimensions: e.dimensions.filter((d: Dimension) => had.has(d.id)) } as unknown as Record<string, unknown>);
    if (bare(eraNow) !== bare(eraThen)) out.push(`era:${eraId}`);
  } else if (eraNow && !eraThen) out.push(`era:${eraId}`);
  for (const kind of ['popValue', 'valueGroup']) {
    const list = storeOf(small.content, kind) as Record<string, { dimension?: string }>;
    for (const id of changedIds(base, small.content, kind)) if (dims.has(String(list[id].dimension)) && !fresh(list[id].dimension)) out.push(`${kind}:${id}`);
  }
  // 文化组：不参与的不算（参与的：上次选了的，和重新生成时会加进来的，同“文化 ⋯”的重新生成）。
  // 第七十七轮：比重就是各组占多少，改了也要重新生成（以前只看是不是 0）
  const chosen = new Set([...h.groups, ...beyondGroupIds(small as SmallState, worldLibrary(small as SmallState) ?? null, lib, h.groups)]);
  const joins = (id: string) => chosen.has(id);
  for (const id of changedIds(base, small.content, 'cultureGroup')) if (joins(id) || storeOf(base, 'cultureGroup')[id]) out.push(`cultureGroup:${id}`);
  const cultures = storeOf(small.content, 'culture') as unknown as Record<string, Culture>;
  for (const id of changedIds(base, small.content, 'culture')) if (joins(cultures[id].group)) out.push(`culture:${id}`);
  return out;
}

// 时代里管国家的几项（国家大小、领海、等级比例、格局、按文化分国、集团的称号、国境外划进国家）：改了要连国家一起重新生成，
// 只重新生成人文时国家的领土不动，这几项就白改了（第八十一轮合并时查出来的）
const ERA_COUNTRY_KEYS = ['countryKm2', 'seaClaimKm', 'tiers', 'patterns', 'nationalism', 'relations', 'unclaimed'] as const;
function eraCountryChange(small: Small, base: Content): boolean {
  const id = small.human?.era;
  if (!id) return false;
  const now = storeOf(small.content, 'era')[id] as Record<string, unknown> | undefined;
  const then = storeOf(base, 'era')[id] as Record<string, unknown> | undefined;
  if (!now || !then || now === then) return false;
  return ERA_COUNTRY_KEYS.some((k) => stableJson(now[k] ?? null) !== stableJson(then[k] ?? null));
}

const changesIn = (small: Small, base: Content, kinds: readonly string[]) => kinds.flatMap((k) => changedIds(base, small.content, k).map((id) => `${k}:${id}`));

// 第八十一轮：省份划分也走这一条。“湖”改了马上整理（不算）；名字、说明不算。世界里没有时按默认的比
const PROVINCE_KEYS: readonly (keyof ProvinceRules)[] = ['size', 'varied', 'wasteland', 'seaByDistance', 'riverCost', 'ridgeCost'];
function provinceChanges(small: Small, base: Content): string[] {
  if (!Object.keys(small.provinces ?? {}).length) return [];
  const a = worldProvinceRules({ content: base });
  const b = worldProvinceRules(small);
  if (a === b || PROVINCE_KEYS.every((k) => a[k] === b[k])) return [];
  return [`provinceRules:${b.id}`];
}

export interface RegenNeed {
  scopes: RegenScope[];
  // 按钮上的字（“添加并重新生成国家”用它；面板底下的条上只写“重新生成”）
  label: string;
  // 灰色的一句：会重做什么
  what: string;
  // 手改过、会被换掉的（没有时 null）
  warn: string | null;
  // 改了几项
  count: number;
}

const HAND_NAME: Record<RegenScope, string> = { provinces: '省份', countries: '国家', human: '人口', settlements: '城市' };

// provinces：省份划分算不算（从资源库添加的“添加并重新生成”不算它，照旧写一句）
export function regenNeed(small: Small, base: RegenBase | null, lib: readonly LibraryEntry[] = [], opts: { provinces?: boolean } = {}): RegenNeed | null {
  if (!base) return null;
  const prov = opts.provinces === false ? [] : provinceChanges(small, base.provinces ?? base.human);
  const hasHuman = !!small.human;
  const hasCountries = hasHuman && !!small.human!.countryRules;
  const hasCities = hasHuman && !!small.settlementRules;
  const human = hasHuman ? humanChanges(small, base.human, lib) : [];
  const gov = hasCountries ? changesIn(small, base.countries, GOV) : [];
  const settle = hasCities ? changesIn(small, base.settlements, SETTLE) : [];
  const count = prov.length + human.length + gov.length + settle.length;
  if (!count) return null;
  const scopes: RegenScope[] = [];
  let label = '';
  const eraGov = hasCountries && human.length > 0 && eraCountryChange(small, base.human);
  if (human.length && (gov.length || eraGov)) {
    scopes.push('human', 'countries');
    label = '重新生成人文和国家';
  } else if (gov.length) {
    scopes.push('countries');
    label = '重新生成国家';
  } else if (human.length) {
    scopes.push('human');
    label = '重新生成人文';
  } else if (settle.length) {
    scopes.push('settlements');
    label = '重新生成城市';
  }
  if (prov.length) {
    scopes.unshift('provinces');
    if (!label) label = '重新划分省份';
  }
  // 会重做什么：人文、国家重新生成时城市跟着重算
  const redo: string[] = [];
  if (prov.length) redo.push('省份');
  if (scopes.includes('human')) redo.push('人口、文化');
  if (scopes.includes('countries')) redo.push(scopes.includes('human') ? '国家' : '国家、人口');
  if (hasCities && (scopes.includes('human') || scopes.includes('countries') || scopes.includes('settlements'))) redo.push('城市');
  const keep = scopes.includes('countries') || prov.length ? '锁定的不动' : scopes.includes('human') ? '国家的领土不动' : '锁定的、自己放的不动';
  // 第八十五轮：国家档案里手写的（备注、改过的统治者、自己写的大事）留着
  const lore = hasCountries && (scopes.includes('countries') || scopes.includes('human')) ? `；${REGEN_KEEPS_ARCHIVE}` : '';
  const what = `会重做${redo.join('、')}；${keep}${lore}`;
  const lost = (base.hand ?? []).filter((s) => scopes.includes(s) && s !== 'human' && s !== 'settlements').map((s) => HAND_NAME[s]);
  return { scopes, count, label, what, warn: lost.length ? `手改过的${lost.join('、')}会被换掉` : null };
}

// 点按钮发的命令：和“文化 ⋯”“国家 ⋯”“城市 ⋯”“省份 ⋯”里的同一条；几样都要时一步（batch，先划分省份：国家按省份长）
export function regenCommand(need: Pick<RegenNeed, 'scopes'>, small: SmallState, lib: readonly LibraryEntry[]): Command {
  const parts: Command[] = [];
  if (need.scopes.includes('provinces')) parts.push({ op: 'generate_provinces', seed: provinceSeed(small) });
  if (need.scopes.includes('human')) parts.push(regenerateCommand(small, lib, need.scopes.includes('countries')));
  else if (need.scopes.includes('countries')) parts.push(withPackImports({ op: 'regenerate_countries' }, small, lib));
  else if (need.scopes.includes('settlements')) parts.push({ op: 'regenerate_settlements' });
  return parts.length === 1 ? parts[0] : { op: 'batch', label: '重新生成', commands: parts };
}

// 从资源库添加之后要不要重新生成（第六十六轮，“添加并重新生成”的按钮）：拿添加前后的内容比，规则和这个按钮一样，只算这一次加的。
// after：添加之后世界里的内容。世界还没生成人文（国家、城市）时那一样不算，没有要重新生成的时 null
export function addedNeed(small: Small, after: Content, lib: readonly LibraryEntry[] = []): RegenNeed | null {
  return regenNeed({ ...small, content: after }, { human: small.content, countries: small.content, settlements: small.content, provinces: small.content }, lib, { provinces: false });
}

// 按钮的字：“添加并重新生成国家”“添加并重新生成人文”“添加并重新生成城市”（人文和国家都要时“添加并重新生成人文和国家”）
export const addRegenLabel = (need: Pick<RegenNeed, 'label'> | null): string | null => (need ? `添加并${need.label}` : null);

export const REGEN_KINDS: readonly string[] = [...HUMAN, ...GOV, ...SETTLE, 'provinceRules'];
