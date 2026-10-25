import type { Command } from '../../core/commands';
import { EXPORT_PARTS, type ExportPartId, exportPartAvailable } from '../../core/export';
import {
  type CityInfo,
  type CityRank,
  type LandmarkInfo,
  type LandmarkType,
  type PointInfo,
  type PointType,
  type RoadPath,
  cityList,
  landmarkList,
  pointList,
  pointTypeById,
  roadPaths,
  smoothRoad,
  worldCityRanks,
  worldLandmarkTypes,
  worldPointTypes,
} from '../../core/human';
import { type NameMode, nameText } from '../../core/name-display';
import type { World } from '../../core/world';
import { CITY_ICONS, type CityIcon, LANDMARK_ICONS, POINT_ICONS, type RoadDraw, type SettleMark } from '../render/settle-draw';
import type { SettleRef } from '../state';
import { hasCountries } from './countries';

// 城市、道路、地标、自定义点（第二十四轮）的界面逻辑：有没有、放大到多少画哪几级、地图上画的点与道路、
// 工具认鼠标下的是哪一个、各种命令、档案的 patch、分开导出的列表。不碰界面，测试直接调

export const NO_CITIES = '先生成国家';
export const SETTLE_PREFIX = 'settle:';

const count = (o: object | undefined) => (o ? Object.keys(o).length : 0);
export function settleCounts(w: Pick<World, 'small'>): { cities: number; roads: number; landmarks: number; points: number } {
  const s = w.small;
  return { cities: count(s.cities), roads: count(s.roads), landmarks: count(s.landmarks), points: count(s.points) };
}
export const hasAnySettle = (w: Pick<World, 'small'>) => Object.values(settleCounts(w)).some((n) => n > 0);
// 能生成城市：有国家（城市按国家的人口分）
export const canGenerateCities = (w: Pick<World, 'small' | 'causes'>) => hasCountries(w);

// ---------- 放大到多少画哪几级（一格在屏幕上的像素数） ----------

// 首都、陪都总画（名字一格 2.5 像素以上）；大城市（level ≥ 3）一格 2 像素以上（名字 4 像素以上）；
// 城市（level 2）一格 5 像素以上（名字 7 像素以上）；村镇一格 10 像素以上（名字 14 像素以上）
export const CAPITAL_NAME_PX = 2.5;
export const BIG_CITY_PX = 2;
export const BIG_NAME_PX = 4;
export const MEDIUM_CITY_PX = 5;
export const MEDIUM_NAME_PX = 7;
export const SMALL_CITY_PX = 10;
export const SMALL_NAME_PX = 14;
// 地标：一格 4 像素以上画图标，9 像素以上写名字
export const LANDMARK_ICON_PX = 4;
export const LANDMARK_NAME_PX = 9;
// 小路：一格 6 像素以上才画
export const MINOR_ROAD_PX = 6;

export const cellPxOf = (w: Pick<World, 'mesh'>, zoom: number) => w.mesh.spacing * zoom;

export function cityIconPx(level: number, capital: boolean): number {
  if (capital) return 0;
  return level >= 3 ? BIG_CITY_PX : level === 2 ? MEDIUM_CITY_PX : SMALL_CITY_PX;
}
export function cityNamePx(level: number, capital: boolean): number {
  if (capital) return CAPITAL_NAME_PX;
  return level >= 3 ? BIG_NAME_PX : level === 2 ? MEDIUM_NAME_PX : SMALL_NAME_PX;
}
export const cityShown = (c: Pick<CityInfo, 'rank' | 'capital' | 'secondCapital'>, cellPx: number) => cellPx >= cityIconPx(c.rank.level, c.capital || c.secondCapital);

// 城市的图标：按等级的 icon（星、双圈、大圆、点），不认识的画大圆
export function cityIconOf(rank: Pick<CityRank, 'icon'>): CityIcon {
  return (CITY_ICONS as readonly string[]).includes(rank.icon) ? (rank.icon as CityIcon) : 'circle';
}
// 名字的字号：按等级的 label 倍数（1 是 11 像素）
export const cityFontPx = (rank: Pick<CityRank, 'label'>) => Math.round(Math.max(8, Math.min(24, 11 * (rank.label ?? 1))));

// 地图上的字：中文 / 原文 / 两者
export const settleLabel = (name: string, orig: string | undefined, nm: NameMode) => nameText(name, orig, nm);

const CITY_TEXT = '#1e2226';
const NATURAL_TEXT = '#5a3b1e';
const MANMADE_TEXT = '#4a2c24';
const POINT_TEXT = '#3b2b4f';

// ---------- 地图上画的点 ----------

export const markKey = (kind: SettleRef['kind'], id: number) => `${SETTLE_PREFIX}${kind}:${id}`;
export function refOfKey(key: string): SettleRef | null {
  if (!key.startsWith(SETTLE_PREFIX)) return null;
  const [kind, id] = key.slice(SETTLE_PREFIX.length).split(':');
  return kind === 'city' || kind === 'road' || kind === 'landmark' || kind === 'point' ? { kind, id: Number(id) } : null;
}

export function cityMark(c: CityInfo, nm: NameMode): SettleMark {
  const capital = c.capital || c.secondCapital;
  return {
    key: markKey(c.point ? 'point' : 'city', c.id),
    kind: 'city',
    x: c.x,
    y: c.y,
    icon: cityIconOf(c.rank),
    ...(c.secondCapital && !c.capital ? { hollow: true } : {}),
    name: settleLabel(c.name, c.orig, nm),
    fontPx: cityFontPx(c.rank),
    ...(capital || c.rank.level >= 3 ? { bold: true } : {}),
    textColor: CITY_TEXT,
    iconPx: cityIconPx(c.rank.level, capital),
    namePx: cityNamePx(c.rank.level, capital),
    ...(capital ? { always: true } : {}),
  };
}

export function landmarkMark(l: LandmarkInfo, nm: NameMode): SettleMark {
  return {
    key: markKey('landmark', l.id),
    kind: 'landmark',
    x: l.x,
    y: l.y,
    icon: l.icon,
    ...(l.color ? { color: l.color } : {}),
    name: settleLabel(l.name, l.orig, nm),
    fontPx: 10.5,
    textColor: l.category === 'natural' ? NATURAL_TEXT : MANMADE_TEXT,
    iconPx: LANDMARK_ICON_PX,
    namePx: LANDMARK_NAME_PX,
  };
}

export function pointMark(p: PointInfo): SettleMark {
  return {
    key: markKey('point', p.id),
    kind: 'point',
    x: p.x,
    y: p.y,
    icon: p.icon ?? 'pin',
    color: p.color,
    ...(p.image ? { image: p.image } : {}),
    name: p.name,
    fontPx: 10.5,
    textColor: POINT_TEXT,
    iconPx: 0,
    namePx: 0,
    always: true,
  };
}

interface Lists {
  cities: CityInfo[];
  landmarks: LandmarkInfo[];
  points: PointInfo[];
}
// 列表：按小数据里的几样缓存（城市的表另在 core 里按人口、领土缓存）
let listMemo: { key: unknown[]; v: Lists } | null = null;
export function settleLists(w: World): Lists {
  const s = w.small;
  const key = [s.cities, s.points, s.landmarks, s.countries, s.content, s.cells, w.causes.country, w.causes.popTotal, w.derived.popCulture, w.mesh, s.terrain];
  if (listMemo && listMemo.key.length === key.length && listMemo.key.every((k, i) => k === key[i])) return listMemo.v;
  const v: Lists = {
    cities: s.cities || s.points ? cityList(w) : [],
    landmarks: s.landmarks ? landmarkList(w) : [],
    points: s.points ? pointList(w) : [],
  };
  listMemo = { key, v };
  return v;
}

// 一格上的城市、地标、点（“这里”的一行用；按列表缓存一张格 → 几样的表）
const atMemo = new WeakMap<Lists, Map<number, { city?: CityInfo; landmarks: LandmarkInfo[]; points: PointInfo[] }>>();
export function settleAt(w: World, cell: number): { city?: CityInfo; landmarks: LandmarkInfo[]; points: PointInfo[] } | undefined {
  const lists = settleLists(w);
  let m = atMemo.get(lists);
  if (!m) {
    m = new Map();
    const get = (c: number) => {
      let e = m!.get(c);
      if (!e) m!.set(c, (e = { landmarks: [], points: [] }));
      return e;
    };
    for (const c of lists.cities) if (!c.point) get(c.cell).city = c;
    for (const l of lists.landmarks) get(l.cell).landmarks.push(l);
    for (const p of lists.points) get(p.cell).points.push(p);
    atMemo.set(lists, m);
  }
  return m.get(cell);
}

// “这里”的一行里写的：城市（首都、陪都）、地标、点的名字
export function settleHere(w: World, cell: number): string {
  if (!w.small.cities && !w.small.landmarks && !w.small.points) return '';
  const e = settleAt(w, cell);
  if (!e) return '';
  const parts: string[] = [];
  if (e.city) parts.push(`${e.city.name}${e.city.capital ? '（首都）' : e.city.secondCapital ? '（陪都）' : ''}`);
  for (const l of e.landmarks) parts.push(l.name);
  for (const p of e.points) if (!p.actsAsCity || !e.city) parts.push(p.name);
  return parts.map((x) => `${x} · `).join('');
}

// 当作城市的点画成城市（挂着的城市画成陪都，没挂时这个点自己当一座城市），不另画点
const pointDrawn = (p: PointInfo) => !p.actsAsCity;

// 画哪些：cities 城市（与当作城市的点），landmarks 全部 / 只画自然的 / 不画，points 自定义点
export interface SettleShow {
  cities: boolean;
  landmarks: 'all' | 'natural' | 'none';
  points: boolean;
}

// 要画的点（重要的在前：首都与大城市、自定义点、别的城市、地标）。同样的输入给同一个数组（地名的版面不必重排）
const markMemo: { lists: Lists; nm: NameMode; show: string; out: SettleMark[] }[] = [];
export function settleMarks(w: World, nm: NameMode, show: SettleShow): SettleMark[] {
  const lists = settleLists(w);
  const sk = `${show.cities}|${show.landmarks}|${show.points}`;
  const hit = markMemo.find((m) => m.lists === lists && m.nm === nm && m.show === sk);
  if (hit) return hit.out;
  const out: SettleMark[] = [];
  // 城市不画时（地理图），当作城市、没挂在城市上的点照样画（它是自定义点）
  const cities = show.cities ? lists.cities : show.points ? lists.cities.filter((c) => c.point) : [];
  const major = cities.filter((c) => c.capital || c.secondCapital || c.rank.level >= 3);
  const rest = cities.filter((c) => !(c.capital || c.secondCapital || c.rank.level >= 3));
  for (const c of major) out.push(cityMark(c, nm));
  if (show.points) for (const p of lists.points) if (pointDrawn(p)) out.push(pointMark(p));
  for (const c of rest) out.push(cityMark(c, nm));
  if (show.landmarks !== 'none') for (const l of lists.landmarks) if (show.landmarks === 'all' || l.category === 'natural') out.push(landmarkMark(l, nm));
  markMemo.unshift({ lists, nm, show: sk, out });
  markMemo.length = Math.min(markMemo.length, 4);
  return out;
}

// 地图上画什么（人文图：城市、全部地标；地理图：只画自然的地标，城市只在“城市”一类开着时、或世界里没有国家时画；自定义点两种图都画）
export function settleShow(o: { political: boolean; countries: boolean; editing: boolean; cities: boolean; landmarks: boolean }): SettleShow {
  return {
    cities: o.cities && (o.political || o.editing || !o.countries),
    landmarks: !o.landmarks ? 'none' : o.political || o.editing ? 'all' : 'natural',
    points: o.landmarks,
  };
}

// ---------- 道路 ----------

export interface RoadSet {
  draw: RoadDraw;
  paths: RoadPath[];
  // draw 里每条折线是哪条路（paths 的下标）
  majorIdx: number[];
  minorIdx: number[];
}
let roadMemo: { roads: unknown; mesh: unknown; v: RoadSet } | null = null;
export function roadSet(w: World): RoadSet | null {
  const roads = w.small.roads;
  if (!roads || !Object.keys(roads).length) return null;
  if (roadMemo && roadMemo.roads === roads && roadMemo.mesh === w.mesh) return roadMemo.v;
  const paths = roadPaths(w);
  const draw: RoadDraw = { major: [], minor: [], majorRaw: [], minorRaw: [], minorPx: MINOR_ROAD_PX };
  const majorIdx: number[] = [];
  const minorIdx: number[] = [];
  paths.forEach((p, k) => {
    const line = smoothRoad(p.points);
    if (p.kind === 'major') {
      draw.major.push(line);
      draw.majorRaw.push(p.points);
      majorIdx.push(k);
    } else {
      draw.minor.push(line);
      draw.minorRaw.push(p.points);
      minorIdx.push(k);
    }
  });
  const v = { draw, paths, majorIdx, minorIdx };
  roadMemo = { roads, mesh: w.mesh, v };
  return v;
}

// ---------- 认鼠标下的是哪一个（工具用） ----------

// 地图上两点的距离（整个星球：经度绕回）
const dist = (w: World, ax: number, ay: number, bx: number, by: number) => {
  let dx = ax - bx;
  if (w.mesh.kind === 'sphere') dx -= 2 * Math.round(dx / 2);
  return Math.hypot(dx, ay - by);
};

// 鼠标下（tol：地图单位）画着的点里最近的一个；kinds：只认这几种
export function pickMark(w: World, marks: readonly SettleMark[], x: number, y: number, tol: number, cellPx: number, kinds?: readonly SettleMark['kind'][]): SettleMark | null {
  let best: SettleMark | null = null;
  let bd = tol;
  for (const m of marks) {
    if (kinds && !kinds.includes(m.kind)) continue;
    if (cellPx < m.iconPx) continue;
    const d = dist(w, m.x, m.y, x, y);
    if (d <= bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

// 点到线段的距离
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const L = vx * vx + vy * vy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L)) : 0;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

// 鼠标下的道路（画着的：小路放大后才认）
export function pickRoad(w: World, x: number, y: number, tol: number, cellPx: number): RoadPath | null {
  const set = roadSet(w);
  if (!set) return null;
  let best: RoadPath | null = null;
  let bd = tol;
  const test = (line: [number, number][], idx: number) => {
    // 整个星球：把鼠标挪到这条线的那一圈上
    let px = x;
    if (w.mesh.kind === 'sphere' && line.length) px = x + 2 * Math.round((line[0][0] - x) / 2);
    for (let k = 1; k < line.length; k++) {
      const [ax, ay] = line[k - 1];
      const [bx, by] = line[k];
      if (Math.min(ax, bx) - bd > px || Math.max(ax, bx) + bd < px || Math.min(ay, by) - bd > y || Math.max(ay, by) + bd < y) continue;
      const d = segDist(px, y, ax, ay, bx, by);
      if (d <= bd) {
        bd = d;
        best = set.paths[idx];
      }
    }
  };
  set.draw.major.forEach((l, k) => test(l, set.majorIdx[k]));
  if (cellPx >= MINOR_ROAD_PX) set.draw.minor.forEach((l, k) => test(l, set.minorIdx[k]));
  return best;
}

// 最近的城市（不含当作城市的点），离得不超过 maxCells 格
export function nearestCity(w: World, x: number, y: number, maxCells = 4): CityInfo | null {
  let best: CityInfo | null = null;
  let bd = maxCells * w.mesh.spacing;
  for (const c of settleLists(w).cities) {
    if (c.point) continue;
    const d = dist(w, c.x, c.y, x, y);
    if (d <= bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

// 放一个点时挂在哪座城市上：类型不当作城市时不写（undefined）；不挂时 null；挂时是附近最近的城市（附近没有城市时 null：这个点自己当一座城市）
export function attachFor(w: World, type: string, x: number, y: number, attach: boolean): number | null | undefined {
  const t = pointTypeById(w.small, type);
  if (!t?.actsAsCity) return undefined;
  if (!attach) return null;
  return nearestCity(w, x, y)?.id ?? null;
}

// ---------- 内容的选择 ----------

export const rankChoices = (w: Pick<World, 'small'>): CityRank[] => [...worldCityRanks(w.small)].sort((a, b) => b.level - a.level);
// 地标的类型：自然的在前（按类别分组）
export const landmarkChoices = (w: Pick<World, 'small'>): LandmarkType[] => [...worldLandmarkTypes(w.small)].sort((a, b) => (a.category === b.category ? 0 : a.category === 'natural' ? -1 : 1));
export const pointChoices = (w: Pick<World, 'small'>): PointType[] => [...worldPointTypes(w.small)];
export const CATEGORY_NAMES = { natural: '自然', manmade: '人造' } as const;

// 放地标、点用的类型：选的不在了时用第一种
export const liveLandmarkType = (w: Pick<World, 'small'>, id: string) => worldLandmarkTypes(w.small).find((t) => t.id === id) ?? landmarkChoices(w)[0];
export const livePointType = (w: Pick<World, 'small'>, id: string) => worldPointTypes(w.small).find((t) => t.id === id) ?? worldPointTypes(w.small)[0];

// 一国的城市（按人口从多到少）
export function countryCityRows(w: World, id: number): CityInfo[] {
  return settleLists(w)
    .cities.filter((c) => c.country === id)
    .sort((a, b) => b.population - a.population || a.id - b.id);
}

// ---------- 命令 ----------

export const addCityCommand = (cell: number, rank?: string): Command => ({ op: 'add_city', cell, ...(rank ? { rank } : {}) });
export const moveCityCommand = (id: number, cell: number): Command => ({ op: 'move_city', id, cell });
export const cityPatchCommand = (id: number, patch: Extract<Command, { op: 'set_city' }>['patch']): Command => ({ op: 'set_city', id, patch });
export const cityRankCommand = (id: number, rank: string | null): Command => cityPatchCommand(id, { rank });

export const addRoadCommand = (cells: number[], kind: string): Command => ({ op: 'add_road', cells, ...(kind !== 'minor' ? { kind } : {}) });
export const editRoadCommand = (id: number, cells: number[]): Command => ({ op: 'edit_road', id, cells });
export const roadKindCommand = (id: number, kind: string): Command => ({ op: 'set_road', id, patch: { kind } });

export const addLandmarkCommand = (type: string, cell: number): Command => ({ op: 'add_landmark', type, cell });
export const moveLandmarkCommand = (id: number, cell: number): Command => ({ op: 'move_landmark', id, cell });
export const landmarkPatchCommand = (id: number, patch: Extract<Command, { op: 'set_landmark' }>['patch']): Command => ({ op: 'set_landmark', id, patch });

export function addPointCommand(type: string, cell: number, x: number, y: number, attachedCity?: number | null): Command {
  return { op: 'add_point', type, cell, x, y, ...(attachedCity !== undefined ? { attachedCity } : {}) };
}
export const movePointCommand = (id: number, cell: number, x: number, y: number): Command => ({ op: 'move_point', id, cell, x, y });
export const pointPatchCommand = (id: number, patch: Extract<Command, { op: 'set_point' }>['patch']): Command => ({ op: 'set_point', id, patch });

export function removeCommand(r: SettleRef): Command {
  switch (r.kind) {
    case 'city':
      return { op: 'remove_city', id: r.id };
    case 'road':
      return { op: 'remove_road', id: r.id };
    case 'landmark':
      return { op: 'remove_landmark', id: r.id };
    case 'point':
      return { op: 'remove_point', id: r.id };
  }
}

// 一起生成、重新生成（只写和记着的不一样的几项）、删除几种
export interface SettleGenChoice {
  roads: boolean;
  landmarks: boolean;
}
export function generateSettleCommand(c: SettleGenChoice): Command {
  return { op: 'generate_settlements', ...(c.roads ? {} : { roads: false }), ...(c.landmarks ? {} : { landmarks: false }) };
}
export function regenerateSettleCommand(w: Pick<World, 'small'>, c: SettleGenChoice): Command {
  const r = w.small.settlementRules;
  return { op: 'regenerate_settlements', ...(c.roads !== (r?.roads ?? true) ? { roads: c.roads } : {}), ...(c.landmarks !== (r?.landmarks ?? true) ? { landmarks: c.landmarks } : {}) };
}
export type SettleKind = 'cities' | 'roads' | 'landmarks' | 'points';
export const SETTLE_KIND_NAMES: Record<SettleKind, string> = { cities: '城市', roads: '道路', landmarks: '地标', points: '自定义点' };
export function removeSettleCommand(kinds: readonly SettleKind[]): Command | null {
  if (!kinds.length) return null;
  return { op: 'remove_settlements', ...Object.fromEntries(kinds.map((k) => [k, true])) } as Command;
}

// ---------- 档案的改动（没变时 null） ----------

// 名字：'' 恢复自动（只在自己起过名字时发）；原文跟着名字
export function settleNamePatch(cur: { name: string; orig?: string; customName: boolean }, name: string, orig: string): { name: string; orig?: string } | null {
  const n = name.trim();
  const o = orig.trim();
  if (!n) return cur.customName ? { name: '' } : null;
  if (n === cur.name && o === (cur.orig ?? '')) return null;
  return { name: n, ...(o ? { orig: o } : {}) };
}

// 建城年份：认“公元前 500 年”“-500”；空着恢复自动（只在自己写过时）
export function cityFoundedPatch(cur: { founded: number; foundedAuto: boolean }, text: string): { founded: number | null } | null {
  const t = text.trim().replace(/^公元前\s*/, '-').replace(/^前\s*/, '-').replace(/\s*年$/, '');
  if (!t) return cur.foundedAuto ? null : { founded: null };
  const v = Number(t);
  if (!Number.isInteger(v) || v < -100000 || v > 100000 || v === cur.founded) return null;
  return { founded: v };
}

// 简介、备注：空着去掉（简介去掉就是恢复自动）
export function textPatch(cur: string | undefined, text: string): string | null | undefined {
  const t = text.trim();
  if (!t) return cur ? null : undefined;
  return text === cur ? undefined : text;
}

// ---------- 分开导出 ----------

export interface ExportPartRow {
  id: ExportPartId;
  label: string;
  files: readonly string[];
  image: boolean;
  available: boolean;
}
export function exportPartRows(w: World): ExportPartRow[] {
  return EXPORT_PARTS.map((p) => ({ id: p.id, label: p.label, files: p.files, image: 'image' in p && !!p.image, available: exportPartAvailable(w, p.id) }));
}

// ---------- 仓库：图标的选法、上传的小图 ----------

export const ICON_LABELS: Record<string, string> = {
  star: '星',
  'double-ring': '双圈',
  circle: '大圆',
  dot: '点',
  peak: '山',
  volcano: '火山',
  waterfall: '瀑布',
  canyon: '峡谷',
  oasis: '棕榈',
  temple: '神庙',
  pyramid: '金字塔',
  wall: '城墙',
  tomb: '墓碑',
  castle: '城堡',
  monastery: '教堂',
  lighthouse: '灯塔',
  shrine: '星光',
  university: '学士帽',
  monument: '奖杯',
  dam: '大坝',
  tower: '法杖',
  spaceport: '火箭',
  dome: '球',
  ruins: '石柱',
  pin: '图钉',
  'star-outline': '星',
  fort: '盾',
  swords: '双剑',
  anchor: '锚',
  pick: '镐',
  tent: '帐篷',
  chest: '宝石',
  flag: '旗',
};

// 三种内容的图标字段：选一个内置的图标
export function iconChoices(kindId: string): string[] | null {
  if (kindId === 'cityRank') return [...CITY_ICONS];
  if (kindId === 'landmarkType') return Object.keys(LANDMARK_ICONS);
  if (kindId === 'pointType') return Object.keys(POINT_ICONS);
  return null;
}

// 点的类型的小图：data: 地址，不超过这么多字
export const IMAGE_MAX_CHARS = 32000;
export const isImageUrl = (s: string) => /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s);
