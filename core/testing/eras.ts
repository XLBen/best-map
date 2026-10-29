import type { Culture, CultureGroup, Era } from '../human/era';
import type { Faction, Government } from '../human/government';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_ERAS, ERA_PACKS } from '../packs/eras';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS, GOV_ERAS } from '../packs/governments';

// 测试里按时代查内置的内容（第三十轮：以前写在时代项里的几张列表在时代文件的 pack 里，见 packs/eras/index.ts）

export const eraOf = (id: string): Era => BUILTIN_ERAS.find((e) => e.id === id)!;
export const govsOf = (era: Pick<Era, 'id'>): Government[] => ERA_PACKS.get(era.id)!.governments.map((id) => BUILTIN_GOVERNMENTS.find((g) => g.id === id)!);
export const factionsOf = (era: Pick<Era, 'id'>): Faction[] => ERA_PACKS.get(era.id)!.factions.map((id) => BUILTIN_FACTIONS.find((f) => f.id === id)!);
// 时代包默认带的文化组与权重
export const defaultsOf = (era: Pick<Era, 'id'>): { id: string; weight: number }[] => ERA_PACKS.get(era.id)!.cultures.map(([id, weight]) => ({ id, weight }));
// 政体、派系文件里写的时代（只用来归包）
export const govEras = (id: string): readonly string[] | undefined => GOV_ERAS.get(id);

// 一个文化组能用在哪些时代：只在奇幻、科幻的包里的（精灵、异星种族……）只用在那个时代，地球上的组（历史上的时代带的、
// “通用 ▸ 文化”里的）哪个时代都能用
const HISTORY = ['antiquity', 'medieval', 'industrial', 'modern'];
const inPack = (era: Pick<Era, 'id'>, g: Pick<CultureGroup, 'id'>) => ERA_PACKS.get(era.id)!.cultures.some(([id]) => id === g.id);
const earthly = (g: Pick<CultureGroup, 'id'>) => BUILTIN_ERAS.every((e) => !inPack(e, g)) || BUILTIN_ERAS.some((e) => HISTORY.includes(e.id) && inPack(e, g));
export const allowed = (era: Pick<Era, 'id'>, g: Pick<CultureGroup, 'id'>): boolean => earthly(g) || inPack(era, g);
export const groupOf = (c: Pick<Culture, 'group'>): CultureGroup => BUILTIN_CULTURE_GROUPS.find((g) => g.id === c.group)!;
export const erasOfCulture = (c: Pick<Culture, 'group'>): Era[] => BUILTIN_ERAS.filter((e) => allowed(e, groupOf(c)));
