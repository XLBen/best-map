import { type Culture, type CultureGroup, type Era, type PopValue, type ValueGroup, cultureGroupSchema, cultureSchema, eraSchema, popValueSchema, valueGroupSchema } from '../../human/era';
import africa from './cultures/africa.json';
import americas from './cultures/americas.json';
import asia from './cultures/asia.json';
import europe from './cultures/europe.json';
import fantasyCultures from './cultures/fantasy.json';
import lost from './cultures/lost.json';
import middleEast from './cultures/middle-east.json';
import oceania from './cultures/oceania.json';
import scifiCultures from './cultures/scifi.json';
import antiquity from './antiquity.json';
import fantasy from './fantasy.json';
import industrial from './industrial.json';
import medieval from './medieval.json';
import modern from './modern.json';
import scifi from './scifi.json';
import nation from './values/nation.json';
import religionGroups from './values/religion-groups.json';
import religion from './values/religion.json';

// 内置的时代与文化（第二十二轮）：格式见 human/era.ts 与 docs/dev/core-human.md。
// 第三十轮起时代就是资源包（packs/builtin-tree.ts 按这里的数据拼出每个时代的大包），这些数据只在主线程用。
//   一个时代一个文件（这里）：{ era, pack, values? }——时代项（只有规则）、时代包里放什么（pack：政体、派系的 id，
//     默认带的文化组与权重 cultures，基础之外的资源 resources），与只属于它的维度的取值（意识形态、种族……）
//   几个时代共用的一维的取值（values/）：一个数组，每项用 eras 写明放进哪几个时代的包（宗教、民族认同）。
//     eras 只是包的归属，读进来的取值不带它（VALUE_ERAS 记着）。同一个 id 只算先列的那一个。
//     取值组（第四十三轮，values/religion-groups.json）：宗教组，取值的 group 指向它
//   第四十三轮：地球上的文化是 EU4 1.37 的文化组与文化，一个地区一个文件（cultures/europe.json……）：
//     { region: {id, name, description}, groups: [{ group, cultures }] }。文化组自带倾向（tendencies、按时代的 eraTendencies）
//     与默认的地名风格（nameStyle），文化只写与组不同的；读进来照原样（合并在用的时候做，见 human/era.ts 的 cultureTendency）。
//   第四十四轮：奇幻、科幻的文化组（种族、物种）各一个文件（cultures/fantasy.json、scifi.json）：{ groups: [{ group, cultures }] }，
//     写法同地区的文件；它们只在奇幻、科幻这两个库里。奇幻的宗教组写在时代文件的 valueGroups 里
// 加一个：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

// 时代包里默认带的一个文化组：[组, 权重]，或 [组, 权重, { except: [不带的文化] }]（中世纪不带殖民地的文化……）
export type EraGroupRef = [string, number] | [string, number, { except: string[] }];

// 时代包里放什么（时代文件的 pack）
export interface EraPackDef {
  governments: string[];
  factions: string[];
  // 默认带的文化组与权重（新建向导默认勾这几组）
  cultures: EraGroupRef[];
  // 基础（库里“基础”的通用资源）之外的资源
  resources?: string[];
}

// 地区（一个文件；第五十一轮起不再是树里的一层，历史库的“文化”下面直接是这些文化组，按这个先后）
export interface CultureRegion {
  id: string;
  name: string;
  description: string;
  groups: string[];
}

const VALUE_FILES: unknown[][] = [religion, nation];
type EraFile = { era: unknown; pack: EraPackDef; values?: unknown[]; valueGroups?: unknown[] };
const ERA_FILES: EraFile[] = [antiquity, medieval, industrial, modern, fantasy, scifi] as EraFile[];
type GroupFile = { group: object; cultures: object[] };
type RegionFile = { region: Omit<CultureRegion, 'groups'>; groups: GroupFile[] };
// 地球上的（EU4 的文化组，按地区）
const REGION_FILES: RegionFile[] = [europe, middleEast, africa, asia, americas, oceania, lost] as RegionFile[];
// 奇幻、科幻的（第四十四轮）
const FICTION_FILES: { groups: GroupFile[] }[] = [fantasyCultures, scifiCultures] as { groups: GroupFile[] }[];
const OTHER_FILES: GroupFile[] = FICTION_FILES.flatMap((f) => f.groups);
const GROUP_FILES: GroupFile[] = [...REGION_FILES.flatMap((r) => r.groups), ...OTHER_FILES];

const unique = <T extends { id: string }>(list: T[]): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
};

export const BUILTIN_ERAS: readonly Era[] = ERA_FILES.map((f) => eraSchema.parse(f.era));
// 每个时代的包里放什么（按时代的 id）
export const ERA_PACKS: ReadonlyMap<string, EraPackDef> = new Map(ERA_FILES.map((f) => [(f.era as { id: string }).id, f.pack]));
const rawValues = unique([...VALUE_FILES.flat(), ...ERA_FILES.flatMap((f) => f.values ?? [])] as { id: string; eras?: string[] }[]);
export const BUILTIN_POP_VALUES: readonly PopValue[] = rawValues.map((v) => popValueSchema.parse(v));
// 取值放进哪几个时代的包（文件里写的 eras；省略时每个有这一维的时代都放）
export const VALUE_ERAS: ReadonlyMap<string, readonly string[] | undefined> = new Map(rawValues.map((v) => [v.id, v.eras]));
// 取值组：共用的宗教组与时代文件自己的（第四十四轮：奇幻的宗教组）
export const BUILTIN_VALUE_GROUPS: readonly ValueGroup[] = unique([...(religionGroups as { id: string }[]), ...ERA_FILES.flatMap((f) => (f.valueGroups ?? []) as { id: string }[])]).map((g) => valueGroupSchema.parse(g));
export const BUILTIN_CULTURE_GROUPS: readonly CultureGroup[] = GROUP_FILES.map((f) => cultureGroupSchema.parse(f.group));
export const BUILTIN_CULTURES: readonly Culture[] = unique(GROUP_FILES.flatMap((f) => f.cultures.map((c) => cultureSchema.parse(c))));
// 地区（欧洲……），按文件的先后
export const CULTURE_REGIONS: readonly CultureRegion[] = REGION_FILES.map((r) => ({ ...r.region, groups: r.groups.map((g) => (g.group as { id: string }).id) }));
