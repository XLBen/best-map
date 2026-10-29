import type { Command, RemovedItem } from './commands';
import { originTarget } from './content/origin';
import { allKinds, itemId, itemName } from './content/registry';
import type { ContentRef } from './content/unused';
import { worldDigest } from './digest';
import { Engine, type WorldDoc } from './engine';
import type { Mesh } from './mesh';
import { isBuiltinSame, originOf } from './packs/builtin-tree';
import type { TidyKept } from './tidy';
import type { World } from './world';

// 压缩世界文件（第二十九轮）：导出世界、存进“我的地图”时调用，当前打开的世界不变，只是写出去的命令更少、更干净。
//   1. 从头重放一遍，记下每条命令新加、移出了哪些内容；
//   2. 加过又移出、中间没有别的命令提到它的：加的那条和移出的那条都去掉（在批量里的只去掉那一条，批量空了整个去掉）；
//   3. 加进来以后一直没用上、最后整理时会移出的（tidy.ts 的计划）：加的那条去掉；
//   4. 末尾补一条整理（tidy_content，带上引擎执行时记下的地名、省份）；
//   5. 压缩后的命令从头重放，最终世界（原因、推导、地物、小数据，见 digest.ts 的 worldDigest）必须与“原来的命令 + 整理”一模一样；
//      不一样就退回原来的命令（末尾照样补上整理：那就是“原来的命令 + 整理”本身，不必再核对）。
// “提到”按命令的 JSON 里有没有这个 id 的字样判断（宁可少去掉）；彼此提到、都要去掉的几条一起去掉。
// 要重放两遍（原来的一遍、压缩后的一遍），大世界上要几秒到几十秒，界面放在后台做

export interface CompactResult {
  doc: WorldDoc;
  // 命令有没有变（只补了一条整理也算）
  changed: boolean;
  // 压缩后核对过一模一样（只补了整理、或者什么都没变时也是 true）；false 是核对不上、退回了原来的命令
  verified: boolean;
  // 去掉了几条（批量里的一条算一条）
  dropped: number;
  // 末尾的整理移出的项（自己做的、改过的由界面存进资源库）与没用到、但移出后地图会变而留着的
  removed: RemovedItem[];
  kept: TidyKept[];
}

// 一条命令里的各条（批量展开；路径是在各层批量里的下标）
interface Leaf {
  top: number;
  path: number[];
  cmd: Command;
  json: string;
}

function leavesOf(cmd: Command, top: number, path: number[] = []): Leaf[] {
  if (cmd.op === 'batch') return cmd.commands.flatMap((c, k) => leavesOf(c, top, [...path, k]));
  return [{ top, path, cmd, json: JSON.stringify(cmd) }];
}

const keyOf = (r: ContentRef) => `${r.kind}\u0000${r.id}`;

// 这一条是不是新加这一项的命令（改一项的 update_species 不算）
function addsItem(cmd: Command, ref: ContentRef): boolean {
  if (cmd.op === 'update_species') return false;
  const t = originTarget(cmd);
  return !!t && t.kind === ref.kind && t.id === ref.id;
}

// 这一条是不是移出这一项的命令
function removesItem(cmd: Command, ref: ContentRef): boolean {
  switch (cmd.op) {
    case 'set_content':
      return cmd.item === null && cmd.kind === ref.kind && cmd.id === ref.id;
    case 'remove_species':
      return ref.kind === 'biome' && cmd.id === ref.id;
    case 'remove_river_type':
      return ref.kind === 'riverType' && cmd.id === ref.id;
    case 'remove_lake_type':
      return ref.kind === 'lakeType' && cmd.id === ref.id;
    case 'remove_island_type':
      return ref.kind === 'islandType' && cmd.id === ref.id;
    case 'remove_field':
      return ref.kind === 'field' && cmd.name === ref.id;
    default:
      return false;
  }
}

// 只有一条对得上时才算（几条都对得上的不动）
function only(leaves: readonly Leaf[], pred: (c: Command) => boolean): Leaf | undefined {
  const hit = leaves.filter((l) => pred(l.cmd));
  return hit.length === 1 ? hit[0] : undefined;
}

// 去掉 drop 里的各条（批量空了整个去掉）
function without(cmd: Command, top: number, drop: ReadonlySet<string>, path: number[] = []): Command | null {
  if (cmd.op !== 'batch') return drop.has(`${top}:${path.join('.')}`) ? null : cmd;
  const inner = cmd.commands.map((c, k) => without(c, top, drop, [...path, k])).filter((c): c is Command => c !== null);
  if (!inner.length) return null;
  return inner.length === cmd.commands.length ? cmd : { ...cmd, commands: inner };
}

interface Candidate {
  ref: ContentRef;
  leaves: Leaf[];
  // 要看有没有被提到的命令范围（顶层的下标，含两头）
  from: number;
  to: number;
  // 去掉加的这一条之后，末尾的整理就不用再移出它
  tidy: boolean;
}

// digestOf：核对用的哈希（省略时是 worldDigest；测试换掉它来试核对不上时的退回）
export function compactWorldDoc(doc: WorldDoc, opts: { mesh?: Mesh; digestOf?: (w: World) => string } = {}): CompactResult {
  const digestOf = opts.digestOf ?? worldDigest;
  // 1. 重放原来的命令，记下每条命令新加、移出的内容
  const added = new Map<number, ContentRef[]>();
  const removed = new Map<number, ContentRef[]>();
  const engine = Engine.fromDoc(doc, opts.mesh, {
    onStep: (k, step) => {
      if (step.added.length) added.set(k, step.added);
      if (step.removed.length) removed.set(k, step.removed.map((r) => ({ kind: r.kind, id: r.id })));
    },
  });
  const plan = engine.planTidy();
  // 原来的命令 + 整理：核对的目标。整理用引擎执行时记下的那一条（带上地名、省份），重放与执行一样
  let tidyCmd: Command | null = null;
  if (plan.command) {
    engine.exec(plan.command);
    tidyCmd = engine.toDoc().commands[engine.toDoc().commands.length - 1];
  }
  engine.update();
  const plain: WorldDoc = tidyCmd ? { ...doc, commands: [...doc.commands, tidyCmd] } : doc;
  const base = { removed: plan.removed, kept: plan.kept };

  // 2、3. 能去掉的：加了又（明确地）移出的、加了以后一直没用上的
  const leaves = doc.commands.map((c, k) => leavesOf(c, k));
  const tidyIds = new Set((plan.command?.items ?? []).map(keyOf));
  const candidates: Candidate[] = [];
  const n = doc.commands.length;
  for (const [k, refs] of added) {
    for (const ref of refs) {
      const add = only(leaves[k], (c) => addsItem(c, ref));
      if (!add) continue;
      // 之后第一次移出它的命令
      let j = k + 1;
      while (j < n && !(removed.get(j) ?? []).some((r) => keyOf(r) === keyOf(ref))) j++;
      if (j < n) {
        const rm = only(leaves[j], (c) => removesItem(c, ref));
        if (rm) candidates.push({ ref, leaves: [add, rm], from: k, to: j, tidy: false });
      } else if (tidyIds.has(keyOf(ref))) candidates.push({ ref, leaves: [add], from: k, to: n - 1, tidy: true });
    }
  }
  // 中间（含两头的批量里的别的条）提到它的不去掉；彼此提到、都要去掉的一起去掉：反复几遍直到不再变
  const leafKey = (l: Leaf) => `${l.top}:${l.path.join('.')}`;
  let active = candidates;
  for (;;) {
    const drop = new Set(active.flatMap((c) => c.leaves.map(leafKey)));
    const next = active.filter((c) => {
      for (let t = c.from; t <= c.to; t++) for (const l of leaves[t]) if (!drop.has(leafKey(l)) && l.json.includes(c.ref.id)) return false;
      return true;
    });
    if (next.length === active.length) break;
    active = next;
  }
  const drop = new Set(active.flatMap((c) => c.leaves.map(leafKey)));
  if (!drop.size) return { doc: plain, changed: plain !== doc, verified: true, dropped: 0, ...base };

  // 4. 压缩后的命令：去掉的那几条，末尾的整理不再移出没加进来的
  const skipTidy = new Set(active.filter((c) => c.tidy).map((c) => keyOf(c.ref)));
  const commands = doc.commands.map((c, k) => without(c, k, drop)).filter((c): c is Command => c !== null);
  const rest = (plan.command?.items ?? []).filter((r) => !skipTidy.has(keyOf(r)));
  if (rest.length) commands.push(rest.length === plan.command!.items!.length ? tidyCmd! : { op: 'tidy_content', items: rest });
  const compact: WorldDoc = { ...doc, commands };

  // 5. 核对
  try {
    const replay = Engine.fromDoc(compact, opts.mesh ?? engine.world.mesh);
    if (digestOf(replay.world) === digestOf(engine.world)) return { doc: compact, changed: true, verified: true, dropped: drop.size, ...base };
  } catch {
    // 重放不了：退回
  }
  return { doc: plain, changed: plain !== doc, verified: false, dropped: 0, ...base };
}

// 只要压缩后的文件
export function compactDoc(doc: WorldDoc, opts: { mesh?: Mesh } = {}): WorldDoc {
  return compactWorldDoc(doc, opts).doc;
}

// ---------- 打开世界文件时拆开 ----------

export interface WorldItem {
  kind: string;
  // 资源包里的段名
  key: string;
  id: string;
  name: string;
  // 写进资源包的样子（与从世界导出时一样）
  item: unknown;
  // 记着的来源（自己做的没有）
  origin?: string[];
}

// 世界里不是内置原样的内容（自己做的、改过的内置项）：打开世界文件时界面把它们存进资源库的“来自《世界名》”（按种类分小包，
// 见 packs.ts 的 addToPack）。能导出的才算（与“从本世界存进资源库”一样：只在这个世界的某处长的生态不算）；
// 与内置的树里一模一样的不算（奇幻的生态、河、湖用到世界时关掉了“自然生成”，也按内置的算）
export function splitWorldContent(world: Pick<World, 'small' | 'causes'>): WorldItem[] {
  const out: WorldItem[] = [];
  for (const k of allKinds()) {
    if (!k.pack.listed || !k.pack.fromWorld) continue;
    for (const x of k.pack.fromWorld(world)) {
      if (isBuiltinSame(k.id, x)) continue;
      const id = itemId(k, x);
      const origin = originOf(world.small, k.id, id, x);
      out.push({ kind: k.id, key: k.pack.key, id, name: itemName(k, x), item: k.pack.exportItem ? k.pack.exportItem(x) : x, ...(origin ? { origin } : {}) });
    }
  }
  return out;
}
