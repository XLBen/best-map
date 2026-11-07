import type { Command } from '../../../core/commands';
import { stableJson } from '../../../core/content/refs';
import type { Culture, Dimension, Era } from '../../../core/human/era';
import type { SmallState } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import type { Content, RegenBase, RegenScope } from '../../regen-track';
import { beyondWeights, regenerateCommand, withPackImports } from '../domain/human';
import { worldLibrary } from '../domain/packChoice';

// 面板顶上的“重新生成”（第六十二轮）：内容改了、地图还没用上时才出现。和上一次生成时的内容比（regen-track.ts 记着），
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
//   文化、时代、取值改了        重新生成人文（国家的领土不动）
//   政体、派系、国家等级改了    重新生成国家（人口按新的国家重算，锁定的不动）
//   两样都改了                  重新生成人文和国家
//   只有城市等级、地标、点改了  重新生成城市（锁定的、自己放的不动）
// 人文、国家重新生成时城市跟着重算，所以这时不用另外一步

type Small = Pick<SmallState, 'content' | 'human' | 'settlementRules'>;
type Store = Record<string, Record<string, unknown>>;

const HUMAN: readonly string[] = ['era', 'popValue', 'valueGroup', 'cultureGroup', 'culture'];
const GOV: readonly string[] = ['government', 'faction', 'countryTier', 'countryLayout', 'countryPattern'];
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
  // 文化组：比重只看是不是 0；不参与的不算（参与的：上次选了的，和重新生成时会加进来的，同“文化 ⋯”的重新生成）
  const chosen = new Set([...h.groups, ...beyondWeights(small as SmallState, worldLibrary(small as SmallState) ?? null, lib, h.groups)].map((g) => g.id));
  const joins = (id: string) => chosen.has(id);
  const bareGroup = (g: Record<string, unknown>) => genKey({ ...g, weight: g.weight === 0 ? 0 : 1 });
  for (const id of changedIds(base, small.content, 'cultureGroup', (x, y) => bareGroup(x) === bareGroup(y))) if (joins(id) || storeOf(base, 'cultureGroup')[id]) out.push(`cultureGroup:${id}`);
  const cultures = storeOf(small.content, 'culture') as unknown as Record<string, Culture>;
  for (const id of changedIds(base, small.content, 'culture')) if (joins(cultures[id].group)) out.push(`culture:${id}`);
  return out;
}

const changesIn = (small: Small, base: Content, kinds: readonly string[]) => kinds.flatMap((k) => changedIds(base, small.content, k).map((id) => `${k}:${id}`));

export interface RegenNeed {
  scopes: RegenScope[];
  // 按钮上的字
  label: string;
  // 灰色的一句：会重算什么
  what: string;
  // 改了几项
  count: number;
}

export function regenNeed(small: Small, base: RegenBase | null, lib: readonly LibraryEntry[] = []): RegenNeed | null {
  if (!base || !small.human) return null;
  const hasCountries = !!small.human.countryRules;
  const hasCities = !!small.settlementRules;
  const human = humanChanges(small, base.human, lib);
  const gov = hasCountries ? changesIn(small, base.countries, GOV) : [];
  const settle = hasCities ? changesIn(small, base.settlements, SETTLE) : [];
  const count = human.length + gov.length + settle.length;
  if (!count) return null;
  const cities = hasCities ? '、城市' : '';
  if (human.length && gov.length) return { scopes: ['human', 'countries'], count, label: '重新生成人文和国家', what: `重算人口、文化、国家${cities}，锁定的不动` };
  if (gov.length) return { scopes: ['countries'], count, label: '重新生成国家', what: `重算国家、人口${cities}，锁定的不动` };
  if (human.length) return { scopes: ['human'], count, label: '重新生成人文', what: `重算人口、文化${cities}，国家的领土不动` };
  return { scopes: ['settlements'], count, label: '重新生成城市', what: '重算城市、道路和地标，锁定的、自己放的不动' };
}

// 点按钮发的命令：和“文化 ⋯”“国家 ⋯”“城市 ⋯”里的重新生成同一条
export function regenCommand(need: Pick<RegenNeed, 'scopes'>, small: SmallState, lib: readonly LibraryEntry[]): Command {
  if (need.scopes.includes('human')) return regenerateCommand(small, lib, need.scopes.includes('countries'));
  if (need.scopes.includes('countries')) return withPackImports({ op: 'regenerate_countries' }, small, lib);
  return { op: 'regenerate_settlements' };
}

// 从资源库添加之后要不要重新生成（第六十六轮，“添加并重新生成”的按钮）：拿添加前后的内容比，规则和这个按钮一样，只算这一次加的。
// after：添加之后世界里的内容。世界还没生成人文（国家、城市）时那一样不算，没有要重新生成的时 null
export function addedNeed(small: Small, after: Content, lib: readonly LibraryEntry[] = []): RegenNeed | null {
  return regenNeed({ ...small, content: after }, { human: small.content, countries: small.content, settlements: small.content }, lib);
}

// 按钮的字：“添加并重新生成国家”“添加并重新生成人文”“添加并重新生成城市”（人文和国家都要时“添加并重新生成人文和国家”）
export const addRegenLabel = (need: Pick<RegenNeed, 'label'> | null): string | null => (need ? `添加并${need.label}` : null);

export const REGEN_KINDS: readonly string[] = [...HUMAN, ...GOV, ...SETTLE];
