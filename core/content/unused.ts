import type { Command } from '../commands';
import { lakeTypesOf } from '../lake-types';
import { riverTypesOf } from '../river-types';
import type { World } from '../world';
import { fieldRefs } from './refs';
import { type ContentWorld, contentItems, itemName, kindOf, usageOf } from './registry';
import { strictWorld } from './usage';

// 世界里哪里都没用到的内容（第二十九轮，整理本世界 tidy_content 与压缩世界文件用）：
//   生态：没有一格以它为主，也没涂过它（世界里一格长生态的陆地都没有时一种都不算：还没到长生态的时候）；
//   河、湖的种类：没画、没选，也没被规则自动套上（推导里没有一格是这一种）；
//   自定义场：哪一项内容都没写到它，也没画过（场里有不是 0 的格）；
//   政体、派系、人口维度的取值：没有国家用、没有人（现在的人口与自动的快照），与资源库里“移出”时查的一样（usage.ts）。
// 只按这些判断，不看移出之后地图变不变：那一步在 tidy.ts 的 planTidy（在世界的副本上真的移出、重算、逐值比较）。
// 结果按种类、再按世界里的先后，同一个世界总是一样

export interface ContentRef {
  kind: string;
  id: string;
}

// 整理时会看的种类（按移出的先后：先移用到场的内容，最后是场）
export const TIDY_KINDS = ['government', 'faction', 'popValue', 'biome', 'riverType', 'lakeType', 'field'] as const;

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

// 写到自定义场的地方：生态、河湖的种类（耐受条件、脚本），其余内容按 JSON 里有没有 field:x、field('x') 这样的写法
function fieldsInUse(w: ContentWorld): Set<string> {
  const out = new Set<string>();
  for (const sp of w.small.species) for (const f of fieldRefs(sp)) out.add(f);
  for (const t of [...riverTypesOf(w.small), ...lakeTypesOf(w.small)]) for (const f of fieldRefs(t)) out.add(f);
  const rest = JSON.stringify([w.small.content ?? {}, w.small.terrain?.gen?.form ?? null]);
  for (const name of Object.keys(w.causes.fields)) if (rest.includes(`field:${name}`) || rest.includes(`field('${name}')`) || rest.includes(`field(\\"${name}\\")`)) out.add(name);
  return out;
}

// 世界里没用到的内容（推导要是最新的）
export function unusedContent(world: TidyWorld): ContentRef[] {
  const { small, causes, derived } = world;
  const out: ContentRef[] = [];
  const strict = strictWorld(world);
  for (const kind of ['government', 'faction', 'popValue'] as const) {
    const k = kindOf(kind)!;
    for (const id of Object.keys(contentItems(small, kind))) if (!usageOf(k, strict, id)) out.push({ kind, id });
  }
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
