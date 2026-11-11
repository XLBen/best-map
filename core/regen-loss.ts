import type { Command } from './commands/schema';
import { countryAutoAt, countryEdited } from './human/auto';
import { regenTargets } from './provinces';
import type { CityMeta, LandmarkMeta, World } from './world';

// 重新生成之前先数：这一次会换掉多少手改的东西（第九十八轮）。界面按它决定问不问——数出来是零就直接做，大于零问一次、写清楚数。
// 纯函数：只读世界和命令记录，不改任何东西，引擎和主线程都能用（界面在 src/ui/domain/regen-ask.ts）。
//
// 每一种手改怎么认、哪一种重新生成留不留，见 docs/dev/history/第98轮.md 的那张表。两种来源：
//   - 世界里记着的记号：手改过人口的格（causes.popManual）、拖过的发源地（locked）、自己放的城市道路地标（没有 auto）、锁定（locked）、
//     写过的简介和备注、挪过的首都（capitalLocked）、自己选的省份颜色……
//   - 没有记号的（改国名、换颜色、换政体、涂领土、改省名、涂省份、切开、合并……）从命令记录里认：上一次重新生成这一样之后的手改命令
//     动过的那几个（history）。没给命令记录时只按记号数，会少数。
// “会被换掉”只算这一次真的不留的：重新生成本来就留着的（keepManual 时手改的格、keepLocked 时锁定的国家、锁定的省份、
// 自己放的和锁定的城市……）不算

export type LossKey = 'pop' | 'hearths' | 'borders' | 'countries' | 'cities' | 'roads' | 'landmarks' | 'provinces';
export interface Loss {
  key: LossKey;
  count: number;
}
// 写出来的先后
const ORDER: readonly LossKey[] = ['pop', 'hearths', 'borders', 'countries', 'cities', 'roads', 'landmarks', 'provinces'];

type W = Pick<World, 'causes' | 'small' | 'mesh'>;

// 这条命令重新生成什么、留什么
interface Plan {
  // 手改过人口的格不留
  pop?: true;
  // 文化组换成这几个：不在里面的组，拖过的发源地不要了（'all'：都不要）
  hearths?: readonly string[] | 'all';
  // 国家重新长；keepLocked：锁定的留着
  countries?: { keepLocked: boolean };
  // 城市：fresh 全部换掉；不然自己放的、锁定的留着（locked：锁定的自动城市也换）
  cities?: { fresh: boolean; locked?: boolean };
  // 道路：全部换掉（不写时画的、改过的留着）
  roads?: true;
  // 地标：fresh 全部换掉；不然自己放的、锁定的留着
  landmarks?: { fresh: boolean };
  // 省份：整张图（'all'）或者这几个；锁定的留着
  provinces?: 'all' | readonly number[];
}

function* flat(cmds: readonly Command[]): Generator<Exclude<Command, { op: 'batch' }>> {
  for (const c of cmds) {
    if (c.op === 'batch') yield* flat(c.commands);
    else yield c;
  }
}

// 这条命令里有没有重新生成（批量里的也算）。没有的不用去数（界面上每改一项内容都会问一次，问得要便宜）
const REGEN_OPS: ReadonlySet<Command['op']> = new Set<Command['op']>([
  'generate_human',
  'regenerate_human',
  'generate_countries',
  'regenerate_countries',
  'move_hearth',
  'generate_settlements',
  'regenerate_settlements',
  'generate_cities',
  'regenerate_cities',
  'generate_roads',
  'generate_landmarks',
  'generate_provinces',
  'regenerate_provinces',
]);
export const isRegen = (cmd: Command): boolean => (cmd.op === 'batch' ? cmd.commands.some(isRegen) : REGEN_OPS.has(cmd.op));

function planOf(w: W, cmd: Command, plan: Plan = {}): Plan {
  const small = w.small;
  // 人文、国家重新生成时城市、地标跟着重算（生成过城市才有）：自己放的、锁定的留着
  const follow = () => {
    if (!small.settlementRules) return;
    plan.cities ??= { fresh: false };
    plan.landmarks ??= { fresh: false };
  };
  switch (cmd.op) {
    case 'batch':
      for (const c of cmd.commands) planOf(w, c, plan);
      break;
    case 'generate_human':
      // 整个换掉（已有人文时人口、发源地、国家都是；没有人文时也可能有自己放的地标、城市）
      plan.pop = true;
      plan.hearths = 'all';
      plan.countries = { keepLocked: false };
      plan.cities = { fresh: true };
      plan.roads = true;
      if (cmd.settlements) plan.landmarks = { fresh: true };
      break;
    case 'regenerate_human':
      if (cmd.keepManual === false || cmd.switchLibrary) plan.pop = true;
      if (cmd.groups) plan.hearths = cmd.groups;
      if (cmd.countries) plan.countries ??= { keepLocked: true };
      follow();
      break;
    case 'generate_countries':
      plan.countries = { keepLocked: false };
      follow();
      break;
    case 'regenerate_countries':
      if (!plan.countries || cmd.keepLocked === false) plan.countries = { keepLocked: cmd.keepLocked ?? true };
      follow();
      break;
    case 'move_hearth':
      if (cmd.keepManual === false) plan.pop = true;
      follow();
      break;
    case 'generate_settlements':
      plan.cities = { fresh: true };
      plan.roads = true;
      plan.landmarks = { fresh: true };
      break;
    case 'regenerate_settlements':
      plan.cities ??= { fresh: false };
      plan.landmarks ??= { fresh: false };
      break;
    case 'generate_cities':
      plan.cities = { fresh: true };
      break;
    case 'regenerate_cities':
      if (!plan.cities?.fresh) plan.cities = { fresh: false, ...(cmd.keepLocked === false || plan.cities?.locked ? { locked: true } : {}) };
      break;
    case 'generate_roads':
      plan.roads = true;
      break;
    case 'generate_landmarks':
      if (!plan.landmarks?.fresh) plan.landmarks = { fresh: cmd.keepManual === false };
      break;
    case 'generate_provinces':
      plan.provinces = 'all';
      break;
    case 'regenerate_provinces':
      if (plan.provinces !== 'all') plan.provinces = [...new Set([...(plan.provinces ?? []), ...regenTargets(w as World, cmd.cells)])];
      break;
  }
  return plan;
}

// ---------- 从命令记录里认手改 ----------

const resets = (c: Command) => c.op === 'set_worldgen' && c.reset === true;
// 国家重新长了、没了：这之前的手改已经不在
const regrows = (c: Command) =>
  c.op === 'generate_human' || (c.op === 'regenerate_human' && !!c.countries) || c.op === 'generate_countries' || c.op === 'regenerate_countries' || c.op === 'remove_countries' || c.op === 'remove_human' || resets(c);
// 自动的城市换过了
const RESETTLE: ReadonlySet<string> = new Set(['generate_human', 'regenerate_human', 'generate_countries', 'regenerate_countries', 'move_hearth', 'generate_settlements', 'regenerate_settlements', 'generate_cities', 'regenerate_cities', 'remove_human']);
const resettles = (c: Command) => RESETTLE.has(c.op) || (c.op === 'remove_settlements' && !!c.cities) || resets(c);
// 整张图重新划分了省份
const repartitions = (c: Command) => c.op === 'generate_provinces' || resets(c);

// 最后一条 boundary 之后的命令（批量里的摊开）
function since(history: readonly Command[], boundary: (c: Command) => boolean): Command[] {
  let out: Command[] = [];
  for (const c of flat(history)) {
    if (boundary(c)) out = [];
    else out.push(c);
  }
  return out;
}

// 手改过的国家：borders 手画过边界的（涂领土、新建、合并、拆分），edited 改过档案的（名字、颜色、政体、首都……；只是锁定、解锁不算）
// kept：这一次留着的国家（锁定的）。涂进它的格跟着它留着，不算会被换掉
function handCountries(w: W, history: readonly Command[] | null, kept: (id: number) => boolean): { borders: Set<number>; edited: Set<number> } {
  const borders = new Set<number>();
  const edited = new Set<number>();
  const { causes, small } = w;
  const metas = small.countries;
  const country = causes.country;
  if (!metas || !country) return { borders, edited };
  const world = w as World;
  const n = country.length;
  // 这一格的领土和生成时不一样：现在归的那一国、生成时归的那一国，边界都改过
  const mark = (i: number) => {
    if (!countryEdited(world, i) || (country[i] >= 0 && kept(country[i]))) return;
    if (country[i] >= 0) borders.add(country[i]);
    const a = countryAutoAt(world, i);
    if (a >= 0) borders.add(a);
  };
  for (const m of Object.values(metas)) if (m.capitalLocked || m.factions) edited.add(m.id);
  if (!history) {
    // 没有命令记录：和生成时不一样的格都算（改地形时跟着挪的边界也会算进来）
    for (let i = 0; i < n; i++) mark(i);
    return { borders, edited };
  }
  const cells = new Set<number>();
  const halved = new Set<number>();
  for (const c of since(history, regrows)) {
    switch (c.op) {
      case 'paint_country':
        for (const i of c.cells) cells.add(i);
        break;
      case 'new_country':
        for (const i of c.cells ?? []) cells.add(i);
        break;
      case 'split_country':
        if (c.cells) for (const i of c.cells) cells.add(i);
        else halved.add(c.id);
        break;
      case 'merge_countries':
        borders.add(c.a);
        break;
      case 'set_country':
        if (Object.keys(c.patch).some((k) => k !== 'locked')) edited.add(c.id);
        break;
      case 'move_capital':
        edited.add(c.id);
        break;
    }
  }
  for (const i of cells) if (i < n) mark(i);
  // 对半拆开的：生成时归它、现在归别国的格
  if (halved.size) for (let i = 0; i < n; i++) if (halved.has(countryAutoAt(world, i))) mark(i);
  return { borders, edited };
}

// 挪过的城市（没有记号）
function movedCities(history: readonly Command[] | null): Set<number> {
  const out = new Set<number>();
  if (history) for (const c of since(history, resettles)) if (c.op === 'move_city') out.add(c.id);
  return out;
}

// 手改过的省份：改名、换颜色、换类型、换地名风格、涂、合并、拆分、切开（只是锁定、解锁不算；重新划分一片出来的是自动的）
function handProvinces(w: W, history: readonly Command[] | null): Set<number> {
  const out = new Set<number>();
  for (const [id, m] of Object.entries(w.small.provinces)) if (m.color !== undefined || m.style !== undefined) out.add(Number(id));
  if (!history) return out;
  for (const c of since(history, repartitions)) {
    // 这一步新划出来的省（引擎记在命令里的 provinceNames）
    const born = () => {
      for (const id of Object.keys(c.provinceNames ?? {})) out.add(Number(id));
    };
    switch (c.op) {
      case 'set_province':
        if (c.name !== undefined || c.kind !== undefined || c.color !== undefined || c.style !== undefined) out.add(c.id);
        break;
      case 'assign_province':
        if (c.province !== 'new') out.add(c.province);
        born();
        break;
      case 'merge_province':
        out.add(c.into);
        break;
      case 'split_province':
        out.add(c.id);
        born();
        break;
      case 'cut_province':
        born();
        break;
    }
  }
  return out;
}

// ---------- 数 ----------

// 自动的城市、地标上手写的（改名字、等级、所属、类型的已经不算自动的了：重新生成时留着）
const cityWritten = (c: CityMeta) => c.description !== undefined || c.notes !== undefined || c.founded !== undefined || !!c.salt;
const landmarkWritten = (l: LandmarkMeta) => l.description !== undefined || !!l.salt;

// 这条命令会换掉的手改，按种类数；一样都没有时是空的。history：世界的命令记录（世界文件里的 commands），没有时给 null
export function regenLoss(w: W, cmd: Command, history: readonly Command[] | null): Loss[] {
  if (!isRegen(cmd)) return [];
  const plan = planOf(w, cmd);
  const { causes, small } = w;
  const count: Partial<Record<LossKey, number>> = {};
  if (plan.pop && causes.popManual) {
    let k = 0;
    const m = causes.popManual;
    for (let i = 0; i < m.length; i++) if (m[i] === 1 && causes.land[i] === 1) k++;
    count.pop = k;
  }
  if (plan.hearths && small.human) {
    const keep = plan.hearths === 'all' ? null : new Set(plan.hearths);
    count.hearths = small.human.hearths.filter((h) => h.locked && !keep?.has(h.group)).length;
  }
  if (plan.countries && small.countries) {
    const metas = small.countries;
    const kept = (id: number) => plan.countries!.keepLocked && !!metas[id]?.locked;
    const { borders, edited } = handCountries(w, history, kept);
    const goes = (id: number) => !!metas[id] && !kept(id);
    count.borders = [...borders].filter(goes).length;
    count.countries = [...edited].filter((id) => goes(id) && !borders.has(id)).length;
  }
  if (plan.cities && small.cities) {
    const moved = movedCities(history);
    const { fresh, locked } = plan.cities;
    const hand = (c: CityMeta) => cityWritten(c) || moved.has(c.id);
    count.cities = Object.values(small.cities).filter((c) => (fresh ? !c.auto || !!c.locked || hand(c) : !!c.auto && (c.locked ? !!locked : hand(c)))).length;
  }
  if (plan.roads && small.roads) count.roads = Object.values(small.roads).filter((r) => !r.auto).length;
  if (plan.landmarks && small.landmarks) {
    const fresh = plan.landmarks.fresh;
    count.landmarks = Object.values(small.landmarks).filter((l) => (fresh ? !l.auto || !!l.locked || landmarkWritten(l) : !!l.auto && !l.locked && landmarkWritten(l))).length;
  }
  if (plan.provinces) {
    const hand = handProvinces(w, history);
    const targets = plan.provinces === 'all' ? null : new Set(plan.provinces);
    count.provinces = [...hand].filter((id) => !!small.provinces[id] && !small.provinces[id].locked && (!targets || targets.has(id))).length;
  }
  return ORDER.filter((k) => (count[k] ?? 0) > 0).map((key) => ({ key, count: count[key]! }));
}

// ---------- 删除之前：一起没了的是什么（按实际删的数） ----------

export interface Removed {
  countries: number;
  blocs: number;
  // 档案里的条目：统治者、家族、大事、写了备注的国家
  archive: number;
  cities: number;
  roads: number;
  landmarks: number;
  points: number;
  // 手改过人口的格（删除人文时）
  pop: number;
}

const size = (o: object | undefined) => (o ? Object.keys(o).length : 0);

function archiveEntries(small: W['small']): number {
  const a = small.archive;
  if (!a) return 0;
  let k = size(a.events);
  for (const c of Object.values(a.countries)) k += c.rulers.length + c.dynasties.length + (c.note !== undefined ? 1 : 0);
  return k;
}

// remove_human、remove_countries、remove_settlements 会删掉多少（别的命令都是 0）
export function removalCounts(w: W, cmd: Command): Removed {
  const { small, causes } = w;
  const out: Removed = { countries: 0, blocs: 0, archive: 0, cities: 0, roads: 0, landmarks: 0, points: 0, pop: 0 };
  const countries = () => {
    out.countries = size(small.countries);
    out.blocs = small.blocs?.length ?? 0;
    out.archive = archiveEntries(small);
  };
  if (cmd.op === 'remove_human') {
    // 国家、城市、道路跟着人文一起删（commands/shared.ts 的 clearPop）；地标、自定义点留着
    countries();
    out.cities = size(small.cities);
    out.roads = size(small.roads);
    const m = causes.popManual;
    if (m) for (let i = 0; i < m.length; i++) if (m[i] === 1 && causes.land[i] === 1) out.pop++;
  } else if (cmd.op === 'remove_countries') countries();
  else if (cmd.op === 'remove_settlements') {
    if (cmd.cities) out.cities = size(small.cities);
    // 道路连着城市：删城市时一起删
    if (cmd.cities || cmd.roads) out.roads = size(small.roads);
    if (cmd.landmarks) out.landmarks = size(small.landmarks);
    if (cmd.points) out.points = size(small.points);
  }
  return out;
}
