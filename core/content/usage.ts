import { ISLAND_CODE_MASK, islandCode, islandTypesOf } from '../island-types';
import { classCode } from '../human/terrain-class';
import { resourceCode } from '../human/resources';
import { worldEra } from '../human/era';
import { eraFactions } from '../human/government';
import { type ContentUsage, type ContentWorld, type UsageWorld, updateKind } from './registry';

// 内容在世界里用在哪里（第二十八轮）：资源库里“移出本世界”之前查一遍，有在用的不让移出，写“有 N 处在用”，带一个定位。
// 引擎的 set_content（停用一项）也查同一个钩子（见 commands.ts 的 setContent），所以在用的内容从核心上就移不出去。
//
// 放在 small.content 里的种类只按原因与小状态数（格的人口、国家、城市、画的格……），重放时结果不变；
// 以前的种类（生态、河湖的种类）在界面里还按推导数（生态长在哪里、哪些河是这一种），引擎不查它们
// （它们有自己的删除：删掉时用到它的地方变回普通的，见 remove_species、remove_river_type……）

// 定位最多给这么多格（镜头只要个范围）
const MAX_CELLS = 20000;

type W = UsageWorld;

const part = (n: number, text: string) => (n > 0 ? [`${n} ${text}`] : []);

function result(parts: string[], count: number, cells: number[]): ContentUsage | null {
  if (count <= 0) return null;
  return { count, label: parts.join('、'), ...(cells.length ? { cells: cells.slice(0, MAX_CELLS) } : {}) };
}

// 有人的格里，满足 pred 的人口群体（编号）占着的格
function popCells(w: W, pred: (tuple: { culture: string; values: Record<string, string> }) => boolean): number[] {
  const out: number[] = [];
  const groups = w.small.popGroups;
  const seen = new Set<number>();
  const scan = (gArr: Uint16Array | undefined, sArr: Uint8Array | undefined) => {
    if (!gArr || !sArr || !groups) return;
    const hit = new Map<number, boolean>();
    const n = gArr.length >> 2;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        const g = gArr[4 * i + k];
        if (!g || !sArr[4 * i + k]) continue;
        let h = hit.get(g);
        if (h === undefined) {
          const t = groups[g];
          h = !!t && pred(t);
          hit.set(g, h);
        }
        if (h) {
          if (!seen.has(i)) {
            seen.add(i);
            out.push(i);
          }
          break;
        }
      }
    }
  };
  scan(w.causes.popGroup, w.causes.popShare);
  return out;
}

// 自动结果的快照（橡皮擦的“恢复自动”）里还用着：移出了恢复时就找不到
function autoUses(w: W, pred: (tuple: { culture: string; values: Record<string, string> }) => boolean): boolean {
  const g = w.causes.popAutoGroup;
  const s = w.causes.popAutoShare;
  const groups = w.small.popGroups;
  if (!g || !s || !groups) return false;
  const hit = new Map<number, boolean>();
  for (let k = 0; k < g.length; k++) {
    if (!g[k] || !s[k]) continue;
    let h = hit.get(g[k]);
    if (h === undefined) {
      const t = groups[g[k]];
      h = !!t && pred(t);
      hit.set(g[k], h);
    }
    if (h) return true;
  }
  return false;
}

// 国家的领土格（定位用）
function countryCells(w: W, ids: readonly number[]): number[] {
  const arr = w.causes.country;
  if (!arr || !ids.length) return [];
  const set = new Set(ids);
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) if (set.has(arr[i])) out.push(i);
  return out;
}

const countries = (w: W) => Object.values(w.small.countries ?? {});

// ---------- 人文 ----------

function cultureUsage(w: W, id: string): ContentUsage | null {
  const is = (t: { culture: string }) => t.culture === id;
  const cells = popCells(w, is);
  const ctry = countries(w).filter((c) => c.primaryCulture === id);
  const h = w.small.human;
  const hearths = h?.hearths.filter((x) => x.culture === id).length ?? 0;
  const listed = h?.groups.some((g) => g.cultures?.includes(id)) ? 1 : 0;
  const auto = !cells.length && autoUses(w, is) ? 1 : 0;
  return result(
    [...part(cells.length, '格有这种文化的人'), ...part(ctry.length, '个国家的主流文化'), ...part(hearths, '个发源地'), ...(listed ? ['生成人文时选了它'] : []), ...(auto ? ['自动的人口里有它'] : [])],
    cells.length + ctry.length + hearths + listed + auto,
    cells.length ? cells : countryCells(w, ctry.map((c) => c.id)),
  );
}

function groupUsage(w: W, id: string): ContentUsage | null {
  const cultures = Object.values((w.small.content?.culture ?? {}) as Record<string, { id: string; group: string }>).filter((c) => c.group === id);
  const mine = new Set(cultures.map((c) => c.id));
  const cells = mine.size ? popCells(w, (t) => mine.has(t.culture)) : [];
  const ctry = countries(w).filter((c) => c.acceptedGroups.includes(id));
  const h = w.small.human;
  const chosen = h?.groups.some((g) => g.id === id) ? 1 : 0;
  const hearths = h?.hearths.filter((x) => x.group === id && !x.culture).length ?? 0;
  return result(
    [...part(cultures.length, '个文化属于它'), ...part(cells.length, '格有这一组的人'), ...part(ctry.length, '个国家'), ...(chosen ? ['生成人文时选了它'] : []), ...part(hearths, '个发源地')],
    cultures.length + cells.length + ctry.length + chosen + hearths,
    cells.length ? cells : countryCells(w, ctry.map((c) => c.id)),
  );
}

function valueUsage(w: W, id: string): ContentUsage | null {
  const is = (t: { values: Record<string, string> }) => Object.values(t.values).includes(id);
  const cells = popCells(w, is);
  const auto = !cells.length && autoUses(w, is) ? 1 : 0;
  return result([...part(cells.length, '格有这样的人'), ...(auto ? ['自动的人口里有它'] : [])], cells.length + auto, cells);
}

function eraUsage(w: W, id: string): ContentUsage | null {
  return w.small.human?.era === id ? { count: 1, label: '人文用的时代' } : null;
}

function governmentUsage(w: W, id: string): ContentUsage | null {
  const ctry = countries(w).filter((c) => c.government === id);
  return result(part(ctry.length, '个国家的政体'), ctry.length, countryCells(w, ctry.map((c) => c.id)));
}

// 派系：国家写了它的影响力；没写的国家按时代的派系自动算（第二十九轮：时代的派系对这些国家也算在用）
function factionUsage(w: W, id: string): ContentUsage | null {
  const era = worldEra(w.small);
  const auto = !!era && eraFactions(w.small, era).some((f) => f.id === id);
  const ctry = countries(w).filter((c) => (c.factions ? c.factions[id] !== undefined : auto));
  return result(part(ctry.length, '个国家有它的影响力'), ctry.length, countryCells(w, ctry.map((c) => c.id)));
}

function styleUsage(w: W, id: string): ContentUsage | null {
  const s = w.small;
  const cultures = Object.values((s.content?.culture ?? {}) as Record<string, { nameStyle: string }>).filter((c) => c.nameStyle === id).length;
  const features = Object.values(s.featureNames).filter((o) => o.style === id).length;
  const provs = Object.entries(s.provinces)
    .filter(([, p]) => p.style === id)
    .map(([k]) => Number(k));
  const cells: number[] = [];
  const prov = (w as { causes: { province?: Int32Array } }).causes.province;
  if (prov && provs.length) {
    const set = new Set(provs);
    for (let i = 0; i < prov.length; i++) if (set.has(prov[i])) cells.push(i);
  }
  // 世界默认不算：停用世界默认的风格时，世界默认一起换回内置中文（见界面的 disableRowCommand）
  return result([...part(cultures, '个文化的地名风格'), ...part(features, '个地名'), ...part(provs.length, '个省份')], cultures + features + provs.length, cells);
}

// ---------- 城市、地标、点 ----------

function settleUsage(list: 'cities' | 'landmarks' | 'points', key: 'rank' | 'type', text: string) {
  return (w: W, id: string): ContentUsage | null => {
    const items = Object.values((w.small[list] ?? {}) as Record<string, { cell: number; rank?: string; type?: string }>).filter((x) => x[key] === id);
    return result(part(items.length, text), items.length, items.map((x) => x.cell));
  };
}

// ---------- 画的格 ----------

function paintedUsage(arr: (w: W) => Uint8Array | undefined, code: (w: W, id: string) => number) {
  return (w: W, id: string): ContentUsage | null => {
    const a = arr(w);
    const c = code(w, id);
    if (!a || !c) return null;
    const cells: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] === c) cells.push(i);
    return result(part(cells.length, '格画成了它'), cells.length, cells);
  };
}

// ---------- 以前的种类：只数手动指定的（按规则自动长出来、套上的不算，移出后那些地方自动换回别的） ----------

function biomeUsage(w: W, id: string): ContentUsage | null {
  const painted = w.small.constraints.filter((c) => c.species === id);
  return result(part(painted.length, '处涂了它'), painted.length, painted.flatMap((c) => c.cells));
}

function riverUsage(w: W, id: string): ContentUsage | null {
  const guides = w.small.guides.filter((g) => g.type === id);
  return result(part(guides.length, '条画的河选了它'), guides.length, guides.flatMap((g) => g.cells));
}

function lakeUsage(w: W, id: string): ContentUsage | null {
  const lakes = w.small.lakes.filter((l) => l.type === id);
  const typed = (w.small.lakeTyping ?? []).filter((e) => e.type === id);
  return result(part(lakes.length + typed.length, '个湖选了它'), lakes.length + typed.length, [...lakes.map((l) => l.cell), ...typed.map((e) => e.cell)]);
}

function islandUsage(w: W, id: string): ContentUsage | null {
  if (!islandTypesOf(w.small).some((t) => t.id === id)) return null;
  const code = islandCode(w.small, id);
  const a = w.causes.islandType;
  const cells: number[] = [];
  if (a && code) for (let i = 0; i < a.length; i++) if ((a[i] & ISLAND_CODE_MASK) === code) cells.push(i);
  return result(part(cells.length, '格是这种岛'), cells.length, cells);
}

// 由 content/kinds.ts 在全部种类登记完之后调用
export function registerUsage(): void {
  const set = (id: string, usage: (w: W, id: string) => ContentUsage | null) => updateKind(id, { usage });
  set('culture', cultureUsage);
  set('cultureGroup', groupUsage);
  set('popValue', valueUsage);
  set('era', eraUsage);
  set('government', governmentUsage);
  set('faction', factionUsage);
  set('nameStyle', styleUsage);
  set('cityRank', settleUsage('cities', 'rank', '座城市定了这个等级'));
  set('landmarkType', settleUsage('landmarks', 'type', '个地标'));
  set('pointType', settleUsage('points', 'type', '个点'));
  set(
    'terrainClass',
    paintedUsage(
      (w) => w.causes.terrainClass,
      (w, id) => classCode(w.small, id),
    ),
  );
  set(
    'resource',
    paintedUsage(
      (w) => w.causes.resource,
      (w, id) => resourceCode(w.small, id),
    ),
  );
  set('biome', biomeUsage);
  set('riverType', riverUsage);
  set('lakeType', lakeUsage);
  set('islandType', islandUsage);
}

// 引擎查的那一份：只按原因与小状态（不看推导，重放时结果不变）
export const strictWorld = (w: ContentWorld): UsageWorld => ({ small: w.small, causes: w.causes });
