// 我的库改一项要多久（第五十九轮）：一个带六个库（六个内置库的副本）的存储里，改一个文化的名字。
//   npx tsx tools/bench-lib-edit.ts [次数]
//   旧：第五十八轮的 editMineList：读一遍（六个库都 parsePack）、克隆这个库、改、这个库再 parsePack、写、再读一遍（六个库都 parsePack）
//   新：library-edit.ts 的 setItem：只查这一项，只换到树根的路，写进日志（JSON + 一张表，和 localStorage 同样要转成字）
//   写库本身（IndexedDB）这里量不到，要在浏览器里量；旧的每改一项写一次整个库，新的停手之后才写一次
import { itemId, kindOf } from '../core/content/registry';
import { type ResourcePack, packItems, parsePack, subPacks } from '../core/packs';
import { builtinPacks } from '../core/packs/builtin-tree';
import { copiedPack, createLibEditor } from '../src/library-edit';
import type { LibraryEntry, Stored } from '../src/library';

const runs = Number(process.argv[2]) || 20;
const median = (list: number[]) => [...list].sort((a, b) => a - b)[list.length >> 1];
const copies: ResourcePack[] = builtinPacks().map((b) => JSON.parse(JSON.stringify(copiedPack(b, `${b.id}-2`, `${b.name} 2`))) as ResourcePack);
const kB = (p: unknown) => Math.round(JSON.stringify(p).length / 1024);
console.log(`六个库：${copies.map((c) => `${c.name} ${kB(c)} KB`).join('，')}`);

const target = copies.find((c) => c.id === 'medieval-2')!;
const kind = kindOf('culture')!;
const first = packItems<Record<string, unknown>>(target, 'cultures')[0];
const id = itemId(kind, first);

// ---------- 旧 ----------
function readAll(): ResourcePack[] {
  return copies.map((c) => {
    const r = parsePack(c);
    if (!r.ok) throw new Error(r.errors[0]);
    return r.pack;
  });
}
function oldEdit(name: string) {
  const all = readAll();
  const cur = all.find((p) => p.id === target.id)!;
  const pack = structuredClone(cur);
  let done = false;
  const walk = (n: ResourcePack | ResourcePack['packs'] extends (infer T)[] | undefined ? T : never) => {
    const list = (n as Record<string, unknown>).cultures as Record<string, unknown>[] | undefined;
    if (list && !done) {
      const k = list.findIndex((x) => x.id === id);
      if (k >= 0) {
        list[k] = { ...list[k], name };
        done = true;
      }
    }
    for (const c of subPacks(n as ResourcePack)) walk(c as never);
  };
  walk(pack as never);
  const r = parsePack(pack);
  if (!r.ok) throw new Error(r.errors[0]);
  readAll();
}

// ---------- 新 ----------
const wal = new Map<string, string>();
let puts = 0;
let list: LibraryEntry[] = copies.map((pack) => ({ key: pack.id, pack, builtin: false, mine: true, installedAt: 1 }));
const ed = createLibEditor(
  {
    put: async (_rec: Stored) => {
      puts++;
      return true;
    },
    walRead: () => null,
    walWrite: (key, w) => {
      if (w) wal.set(key, JSON.stringify(w));
      else wal.delete(key);
      return true;
    },
  },
  { entries: () => list, publish: (key, pack) => void (list = list.map((e) => (e.key === key ? { ...e, pack } : e))) },
);

const oldTimes: number[] = [];
const newTimes: number[] = [];
const undoTimes: number[] = [];
for (let k = 0; k < runs; k++) {
  const name = `名字 ${k}`;
  let t = performance.now();
  oldEdit(name);
  oldTimes.push(performance.now() - t);
  t = performance.now();
  const r = ed.setItem(target.id, 'culture', id, { ...first, name });
  newTimes.push(performance.now() - t);
  if (!r.ok) throw new Error(r.error);
  t = performance.now();
  ed.undo(target.id);
  undoTimes.push(performance.now() - t);
  ed.redo(target.id);
}
console.log(`改一项（校验 + 存）的中位数，${runs} 次：`);
console.log(`  旧：${median(oldTimes).toFixed(1)} ms（整库校验 13 次的量，另加写一次整个库）`);
console.log(`  新：${median(newTimes).toFixed(3)} ms（只查这一项，写日志；这期间写整个库 ${puts} 次）`);
console.log(`  撤销：${median(undoTimes).toFixed(3)} ms`);
const t = performance.now();
readAll();
console.log(`  读一遍六个库（都 parsePack，旧的每次打开面板都要）：${(performance.now() - t).toFixed(1)} ms；新的同一版不再查`);
process.exit(0);
