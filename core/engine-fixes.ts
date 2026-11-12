// 一步做完之后引擎接着做的三样整理（第九十七轮从 core/engine.ts 的 Engine 原样搬出，this 换成 e；Engine 里同名的几个方法只转到这里）：
//   名字跟着地方走、湖与陆地省份的整理、人口的修补。结果都记进这一步的命令与撤销记录（重放、重做时照用）
import { type GeoFeature, applyNameCarry, carryNames, mergeNameCarry } from './features';
import { type Command, Dirty, addArrayUndo } from './commands';
import { type SmallCopy, restoreSmall } from './small-copy';
import { lakeProvinceFix } from './provinces';
import { SLOTS } from './human/groups';
import { applyPopFix, moveCells, populationFix } from './human/population';
import { computePopLayers } from './human/layers';
import type { Derived, World } from './world';
import type { DoneStep } from './engine-types';
import { onlyRestyled } from './engine-helpers';

// 这几样整理读写的引擎状态（Engine 的同名字段；私有的几项由 Engine 转交）
export interface FixState {
  world: World;
  features: boolean;
  done: DoneStep[];
  dirty: Dirty;
  update(): Derived;
}

// 这一步之前的水面（海、湖）与宜居度
export interface WaterBefore {
  water: Uint8Array;
  hab: Float32Array;
}

// 名字跟着地方走（见 features.ts 的 carryNames）：最后一步重算之后，与这一步之前的地物 prev 比，
// 锚点挪了、名字被新出来的地物抢了的地物留着原来的名字，落不到地物上的改名挪过去。记进这一步的命令
// （重放、重做时照用，所以从头重放与一步一步编辑一字不差），再重新起名。只改名字、省份的步，没识别地物时不做
// prevSmall：prev 那时的小数据（副本），默认是这一步之前的
export function carryStepNames(e: FixState, prev: GeoFeature[], prevSmall?: SmallCopy) {
  const step = e.done[e.done.length - 1];
  if (!e.features || !step || step.dirty <= Dirty.None || !prev.length) return;
  const w = e.world;
  // 只重算了人文的几层（第二十二轮）：地物还是那些，名字变了的都是换了风格（当地的文化变了）的，起名的办法变了，
  // 没有要留的名字（与整个比一遍的结果相同，省下三遍起名）
  if (step.dirty === Dirty.Human && step.cmd.op !== 'batch' && onlyRestyled(prev, w.derived.features)) return;
  const carry = carryNames(w, w.derived.features, restoreSmall(prevSmall ?? step.undo), prev);
  if (!carry) return;
  applyNameCarry(w.small, carry);
  step.cmd = { ...step.cmd, nameCarry: mergeNameCarry(step.cmd.nameCarry, carry) };
  e.dirty = Dirty.Names;
  e.update();
}

// 湖与陆地省份的整理（见 provinces.ts 的 lakeProvinceFix）：这一步改了推导（放湖、删湖、湖干了、地形变了）之后，
// 按新的湖把格放进对的省份。结果记进这一步的命令（重放、重做时照用，不用推导）与撤销记录；省份不进推导，不用重算
export function fixLakeProvinces(e: FixState) {
  const step = e.done[e.done.length - 1];
  if (!step || step.dirty <= Dirty.None || step.cmd.provinceFix) return;
  // 只画了人文（第二十二轮）：湖、陆海、岛的种类都没变，不用整理
  if (step.dirty === Dirty.Human && step.cmd.op !== 'batch') return;
  const w = e.world;
  const before = w.causes.province.slice();
  const fix = lakeProvinceFix(w, w.derived);
  if (!fix) return;
  addArrayUndo(step.undo, 'province', fix.cells, before);
  step.cmd = { ...withoutDropped(step.cmd, fix.drop), provinceFix: fix };
}

// 这一步新起了名字、整理又删掉的省（新建时整个落在湖面上的陆地省：格都进了湖省）：名字不留在命令里。
// 重放、重做时整理在收尾之前就做了（commands.ts 的 settleApply），收尾记省名时这些省已经不在，记下的本来就没有它们——
// 第一次执行记的要和重放记的一字不差（存了再开，文件不变）。一个都不剩时原样留着：重放时这一步没有新起的省名，命令照原样记
function withoutDropped(cmd: Command, drop: readonly number[]): Command {
  const names = cmd.provinceNames;
  if (!names || !drop.some((id) => id in names)) return cmd;
  const gone = new Set(drop.map(String));
  const left = Object.fromEntries(Object.entries(names).filter(([id]) => !gone.has(id)));
  if (!Object.keys(left).length) return cmd;
  const out: Command = { ...cmd, provinceNames: left };
  if (cmd.provinceOrig) {
    const orig = Object.fromEntries(Object.entries(cmd.provinceOrig).filter(([id]) => !gone.has(id)));
    if (Object.keys(orig).length) out.provinceOrig = orig;
    else delete out.provinceOrig;
  }
  return out;
}

// 有人文时这一步之前的水面（海、湖）与宜居度（第八十四轮）：改了陆海、宜居度之后修补人口用（见 fixPopulation）
export function waterMask(w: World): WaterBefore | null {
  if (!w.small.human || !w.causes.popTotal) return null;
  const n = w.mesh.n;
  const land = w.causes.land;
  const lake = w.derived.lake;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!land[i] || lake[i] === 1) out[i] = 1;
  return { water: out, hab: w.derived.habitability };
}

// 人口的修补（第二十二轮，见 human/population.ts 的 populationFix）：这一步改了陆海、湖之后，变成水面的格没有人了，
// 新的干的陆地按宜居度补上人；第八十四轮：宜居度变了的地方一带的人按新的宜居度在本国里重新分（总数不变）。结果记进这一步的命令（popFix，重放、重做时照用）与撤销记录，再重算人文的几层与名字
export function fixPopulation(e: FixState, water0: WaterBefore | null) {
  const step = e.done[e.done.length - 1];
  const w = e.world;
  if (!water0 || !step || step.dirty <= Dirty.Human || step.cmd.popFix || !w.small.human || !w.causes.popTotal) return;
  const fix = populationFix(w, w.derived, water0.water, water0.hab);
  if (!fix) return;
  const c = w.causes;
  const before = { t: c.popTotal!.slice(), g: fix.cells.length ? c.popGroup!.slice() : c.popGroup!, s: fix.cells.length ? c.popShare!.slice() : c.popShare! };
  applyPopFix(w, fix);
  const slots = fix.cells.flatMap((i) => Array.from({ length: SLOTS }, (_, k) => i * SLOTS + k));
  addArrayUndo(step.undo, 'popTotal', fix.moves ? [...new Set([...fix.cells, ...moveCells(fix.moves)])].sort((a, b) => a - b) : fix.cells, before.t);
  if (fix.cells.length) {
    addArrayUndo(step.undo, 'popGroup', slots, before.g);
    addArrayUndo(step.undo, 'popShare', slots, before.s);
  }
  step.cmd = { ...step.cmd, popFix: fix };
  // 第八十四轮：只挪了人数（成分、陆海都没变）时只重算人口的几层（地名、国家的一层不看人数），不再走一遍人文
  if (!fix.cells.length) {
    computePopLayers(w, w.derived);
    return;
  }
  e.dirty = Dirty.Human;
  e.update();
}
