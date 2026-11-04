import type { Command } from '../commands';
import { lakeTypesOf } from '../lake-types';
import { worldMapStyleId, worldMapStyles } from '../map-style';
import { styleInUse } from '../name-styles';
import { riverTypesOf } from '../river-types';
import type { World } from '../world';
import { type ContentRef, linkIds } from './links';
import { type ContentWorld, type UsageWorld, allKinds, contentItems, itemName, kindOf, usageOf } from './registry';
import { strictWorld } from './usage';

// 世界里哪里都没用到的内容（第二十九轮，整理本世界 tidy_content 与压缩世界文件用）：
//   生态：没有一格以它为主，也没涂过它（世界里一格长生态的陆地都没有时一种都不算：还没到长生态的时候）；
//   河、湖的种类：没画、没选，也没被规则自动套上（推导里没有一格是这一种）；
//   自定义场：哪一项内容都没写到它，也没画过（场里有不是 0 的格）；
//   政体、人口维度的取值：没有国家用、没有人（现在的人口与自动的快照），与资源库里“移出”时查的一样（usage.ts）；
//   派系（第五十三轮）：移出没用到的政体之后没有政体列着它；
//   取值组（第四十三轮）：移出没用到的取值之后没有取值属于它的；
//   文化（第五十轮）：没有人（现在的人口与自动的快照）、不是国家的主流文化、没有发源地、生成时没点名的；
//   文化组（第五十轮）：移出没用到的文化之后没有文化属于它，也没有国家兼容、生成时没选、没有发源地的；
//   地名风格（第五十轮）：移出上面那些之后没有文化、文化组写到，也不是世界默认、地名、省份用的；
//   时代（第五十轮）：人文用的那一个以外的；
//   画风（第三十八轮）：世界在用的那一种（选的，没选时第一种）以外的。
// 只按这些判断，不看移出之后地图变不变：那一步在 tidy.ts 的 planTidy（在世界的副本上真的移出、重算、逐值比较）。
// 结果按种类、再按世界里的先后，同一个世界总是一样

export type { ContentRef };

// 整理时会看的种类（按移出的先后：先移用到别的项的，文化在文化组之前，文化、文化组在地名风格之前，用到场的内容在场之前）
export const TIDY_KINDS = ['government', 'faction', 'popValue', 'valueGroup', 'culture', 'cultureGroup', 'nameStyle', 'era', 'mapStyle', 'biome', 'riverType', 'lakeType', 'field'] as const;

type TidyWorld = ContentWorld & Pick<World, 'derived'>;

function usedCodes(arr: Uint8Array | Int16Array | undefined, size: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, size));
  if (!arr) return out;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v >= 0 && v < out.length) out[v] = 1;
  }
  return out;
}

// 写到自定义场的地方（引用表，见 links.ts：耐受条件、脚本，哪一种内容都一样）
function fieldsInUse(w: ContentWorld): Set<string> {
  const out = new Set<string>();
  for (const k of allKinds()) for (const x of k.inWorld(w)) for (const f of linkIds(k, x, 'field')) out.add(f);
  return out;
}

// 小数据去掉 gone 里这一种的项（查“移出它们之后还有没有用到”）
export function withoutItems<S extends Pick<World['small'], 'content'>>(small: S, kind: string, gone: readonly ContentRef[]): S {
  const ids = new Set(gone.filter((x) => x.kind === kind).map((x) => x.id));
  const own = small.content?.[kind] as Record<string, unknown> | undefined;
  if (!ids.size || !own) return small;
  return { ...small, content: { ...small.content, [kind]: Object.fromEntries(Object.entries(own).filter(([id]) => !ids.has(id))) } };
}

// 人文和政治这几种（政体、派系、取值、取值组、文化、文化组、地名风格、时代）里没用到的。只看原因与小状态，不看推导。
// 第六十二轮分出来：面板上的变淡、“清理没用到的”只看这几种（见 cleanable.ts）
export function unusedPeople(world: ContentWorld): ContentRef[] {
  const { small } = world;
  const out: ContentRef[] = [];
  const strict = strictWorld(world);
  // 派系按移出没用到的政体之后的世界查：只有它们列着的派系也没用到
  const after = (...kinds: string[]): UsageWorld => ({ ...strict, small: kinds.reduce((s, kind) => withoutItems(s, kind, out), small) });
  for (const kind of ['government', 'faction', 'popValue'] as const) {
    const k = kindOf(kind)!;
    const w = kind === 'faction' ? after('government') : strict;
    for (const id of Object.keys(contentItems(small, kind))) if (!usageOf(k, w, id)) out.push({ kind, id });
  }
  // 取值组（第四十三轮）：移出上面那些取值之后没有取值属于它的
  const goneValues = new Set(out.filter((x) => x.kind === 'popValue').map((x) => x.id));
  const heldGroups = new Set(Object.values(contentItems<{ id: string; group?: string }>(small, 'popValue')).flatMap((v) => (!goneValues.has(v.id) && v.group ? [v.group] : [])));
  for (const id of Object.keys(contentItems(small, 'valueGroup'))) if (!heldGroups.has(id)) out.push({ kind: 'valueGroup', id });
  // 文化、文化组、地名风格：一层层算，后面的按移出前面那些之后的世界查
  const unusedOf = (kind: 'culture' | 'cultureGroup' | 'nameStyle' | 'era', w: UsageWorld) => {
    const k = kindOf(kind)!;
    for (const id of Object.keys(contentItems(small, kind))) if (!usageOf(k, w, id) && !(kind === 'nameStyle' && styleInUse(w.small, id))) out.push({ kind, id });
  };
  unusedOf('culture', strict);
  unusedOf('cultureGroup', after('culture'));
  unusedOf('nameStyle', after('culture', 'cultureGroup'));
  unusedOf('era', strict);
  return out;
}

// 世界里没用到的内容（推导要是最新的）
export function unusedContent(world: TidyWorld): ContentRef[] {
  const { small, causes, derived } = world;
  const out = unusedPeople(world);
  // 画风：只留世界在用的那一种
  const style = worldMapStyleId(small);
  for (const id of Object.keys(worldMapStyles(small))) if (id !== style) out.push({ kind: 'mapStyle', id });
  // 生态：没有一格以它为主（下标）、没涂过
  const dom = usedCodes(derived.dominant, small.species.length);
  if (dom.some((x) => x)) {
    const painted = new Set(small.constraints.map((c) => c.species));
    small.species.forEach((s, k) => {
      if (!dom[k] && !painted.has(s.id)) out.push({ kind: 'biome', id: s.id });
    });
  }
  // 河的种类：推导里第 k 种的编号是 k + 1
  const rivers = riverTypesOf(small);
  const rCode = usedCodes(derived.riverType, rivers.length + 1);
  const drawn = new Set(small.guides.flatMap((g) => (g.type ? [g.type] : [])));
  rivers.forEach((t, k) => {
    if (!rCode[k + 1] && !drawn.has(t.id)) out.push({ kind: 'riverType', id: t.id });
  });
  const lakes = lakeTypesOf(small);
  const lCode = usedCodes(derived.lakeType, lakes.length + 1);
  const picked = new Set([...small.lakes.flatMap((l) => (l.type ? [l.type] : [])), ...(small.lakeTyping ?? []).map((e) => e.type)]);
  lakes.forEach((t, k) => {
    if (!lCode[k + 1] && !picked.has(t.id)) out.push({ kind: 'lakeType', id: t.id });
  });
  // 自定义场：移出上面那些之后还有没有内容写到它（移出的生态、河湖的种类不算）
  const goneSpecies = new Set(out.filter((x) => x.kind === 'biome').map((x) => x.id));
  const goneRivers = new Set(out.filter((x) => x.kind === 'riverType').map((x) => x.id));
  const goneLakes = new Set(out.filter((x) => x.kind === 'lakeType').map((x) => x.id));
  const left: ContentWorld = {
    causes,
    small: {
      ...small,
      species: small.species.filter((s) => !goneSpecies.has(s.id)),
      riverTypes: rivers.filter((t) => !goneRivers.has(t.id)),
      lakeTypes: lakes.filter((t) => !goneLakes.has(t.id)),
    },
  };
  const used = fieldsInUse(left);
  for (const [name, arr] of Object.entries(causes.fields)) {
    if (used.has(name)) continue;
    if (arr.some((v) => v !== 0)) continue;
    out.push({ kind: 'field', id: name });
  }
  return out;
}

// 移出一项的命令（与资源库里“移出本世界”同一条）
export function removeCommand(ref: ContentRef): Command {
  switch (ref.kind) {
    case 'biome':
      return { op: 'remove_species', id: ref.id };
    case 'riverType':
      return { op: 'remove_river_type', id: ref.id };
    case 'lakeType':
      return { op: 'remove_lake_type', id: ref.id };
    case 'field':
      return { op: 'remove_field', name: ref.id };
    default:
      return { op: 'set_content', kind: ref.kind, id: ref.id, item: null };
  }
}

// 历史里的名字
export function refName(world: ContentWorld, ref: ContentRef): string {
  const k = kindOf(ref.kind);
  if (!k) return ref.id;
  const item = k.inWorld(world).find((x) => (k.idOf ? k.idOf(x) : (x as { id?: string }).id) === ref.id);
  return item === undefined ? ref.id : itemName(k, item);
}
