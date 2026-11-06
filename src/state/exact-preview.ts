import type { Command } from '../../core/commands';
import type { PreviewResult, ProvincesPreview } from '../../core/engine';
import { previewWorldOf } from '../../core/preview-world';
import type { TerrainPatch, TerrainPreview } from '../../core/terrain';
import type { World } from '../../core/world';
import type { Response } from '../protocol';
import { seedRivers } from '../render/overlay';
import { noteCost, slowHint, slowPreview } from './cost-gate';
import { exec } from './edits';
import type { NoteAction } from './notes';
import { call, hostHooks, isPending } from './worker-host';
import { adjustPreview, adjustPreviewNote, adjustPreviewWorld, world, worldState } from './world';

// 预览（第七十轮从 state.ts 分出来）：“调整”的地形预览、命令的预览、省份的轻预览、确切预览（将来的世界）与调整面板的预览

// “调整”面板拖滑块时的地形预览：同一时间只算一个，拖动中只算最新的值。
// 算好的照样先显示（后面已经有更新的值在排队也显示，但一秒最多换几次，大星球上换一次要几十毫秒）：
// 一直拖着不停时，海岸线慢一步跟着滑块走，而不是一直不出来
let terrainPending: TerrainPatch | null = null;
let terrainBusy = false;
// 正在算的、显示着的是哪个值（JSON）：松手时据此决定还要不要再算一遍（见 commitTerrain）
let terrainFlight = '';
let terrainShown: { key: string; t: TerrainPreview; at: number } | null = null;
// 每次清掉预览就换一代：还在路上的旧结果不再显示
let terrainGen = 0;
// 要过几次预览（清掉也算）：松手执行后据此判断用户是不是又拖了（见 commitTerrain）
let terrainAsked = 0;
export function previewTerrain(patch: TerrainPatch | null) {
  terrainAsked++;
  if (!patch) {
    terrainPending = null;
    terrainGen++;
    adjustPreview.value = null;
    return;
  }
  terrainPending = patch;
  if (terrainBusy) return;
  void (async () => {
    terrainBusy = true;
    while (terrainPending) {
      const p = terrainPending;
      terrainPending = null;
      const gen = terrainGen;
      const w = world.value;
      const key = JSON.stringify(p);
      terrainFlight = key;
      const r = await call({ kind: 'previewTerrain', patch: p }, null);
      terrainFlight = '';
      // 算的过程中松手了（不要了）、世界变了，这个结果就不要了；后面还有更新的值、刚换过一次的，也先不换
      const soon = terrainPending !== null && terrainShown !== null && performance.now() - terrainShown.at < 150;
      if (r.ok && r.terrain && gen === terrainGen && world.value === w && !soon) showTerrain(key, r.terrain);
    }
    terrainBusy = false;
  })();
}

function showTerrain(key: string, t: TerrainPreview) {
  terrainShown = { key, t, at: performance.now() };
  adjustPreview.value = t;
}

// “调整”的地形滑块松手：执行命令，拖到的那个值的预览（将来的海岸线）留在地图上，直到结果换上
// （applySnapshot 时清掉），算的期间不闪回旧的海岸。松手的值还没算过、也不在算（一直拖着没停就松手）：
// 现在就算它，Worker 按顺序处理，它在执行之前算好；排队的、在算的旧值作废。
// 没有变化、出错时在这里清掉；松手后又拖了就不动（那是新的预览）
export async function commitTerrain(cmd: Command, label: string, patch: TerrainPatch | null): Promise<boolean> {
  if (patch) {
    const key = JSON.stringify(patch);
    terrainPending = null;
    if (key !== terrainFlight) {
      const gen = ++terrainGen;
      const w = world.value;
      const shown = terrainShown?.key === key && adjustPreview.value === terrainShown.t;
      if (!shown) {
        void call({ kind: 'previewTerrain', patch }, null).then((r) => {
          if (r.ok && r.terrain && gen === terrainGen && world.value === w) showTerrain(key, r.terrain);
        });
      }
    }
  }
  const mark = terrainAsked;
  const ok = await exec(cmd, label);
  if (terrainAsked === mark && adjustPreview.value) previewTerrain(null);
  return ok;
}

// 一次性的地形预览（重画这一片悬停时）：同一时间只算一个，排队时来了新的，旧的直接得到 null（见下面的 latest）；
// 算的过程中世界换了也得到 null。结果里的 ms 是 Worker 算它用了多久（工具据此决定要不要自动预览）
const terrainOnce = latest(async (patch: TerrainPatch) => {
  const w = world.value;
  const r = await call({ kind: 'previewTerrain', patch }, null);
  return r.ok && r.terrain && world.value === w ? r.terrain : null;
});
export function previewTerrainOnce(patch: TerrainPatch): Promise<TerrainPreview | null> {
  return terrainOnce.ask(patch);
}

// 命令的确切预览：在世界的副本上执行，返回会出现 / 消失的河等（画河改道时用）。
// 同一时间只算一个；排队时来了新的，旧的直接得到 null。Worker 留着算好的副本，紧接着执行同一条命令时直接采用
let cmdPending: { cmd: Command; resolve: (r: PreviewResult | null) => void } | null = null;

// 不再需要的预览（松手提交了、取消了）：还在排队的直接作废，不再发给 Worker
export function cancelPreviews() {
  cmdPending?.resolve(null);
  cmdPending = null;
}
let cmdBusy = false;
export function previewCommand(cmd: Command): Promise<PreviewResult | null> {
  return new Promise((resolve) => {
    cmdPending?.resolve(null);
    cmdPending = { cmd, resolve };
    if (cmdBusy) return;
    void (async () => {
      cmdBusy = true;
      while (cmdPending) {
        const p = cmdPending;
        cmdPending = null;
        const w = world.value;
        const r = await call({ kind: 'preview', cmd: p.cmd }, null);
        p.resolve(r.ok && r.preview && world.value === w ? r.preview : null);
      }
      cmdBusy = false;
    })();
  });
}

// 省份命令的轻预览（重划、按新规则重新划分、换一种划分）：只算省份，返回执行后的省份数组、各省（含新起的名字）与切线。
// 同一时间只算一个；排队时来了新的，旧的直接得到 null（见下面的 latest）。做不成（比如涂得不够）、世界已经变了也是 null，不提示
const provincePreviews = latest(async (cmd: Command) => {
  const w = world.value;
  const r = await call({ kind: 'previewProvinces', cmd }, null);
  return r.ok && r.provinces && world.value === w ? r.provinces : null;
});
export function previewProvinces(cmd: Command): Promise<ProvincesPreview | null> {
  return provincePreviews.ask(cmd);
}

// ---------- 确切预览：将来的世界 ----------

// 同一时间只算一个；排队时来了新的，旧的直接得到 null（拖动中只算最新的那个）。
// cancel：正在算的那个也不要了时叫它（确切预览：Worker 在下一个阶段之间停下，不必等它算完）
function latest<A, R>(run: (a: A) => Promise<R | null>, cancel?: () => void) {
  let waiting: { a: A; resolve: (r: R | null) => void } | null = null;
  let running = false;
  return {
    ask: (a: A) =>
      new Promise<R | null>((resolve) => {
        waiting?.resolve(null);
        waiting = { a, resolve };
        if (running) {
          cancel?.();
          return;
        }
        void (async () => {
          running = true;
          while (waiting) {
            const p = waiting;
            waiting = null;
            // 出了错也当没有结果，不卡住后面的预览
            p.resolve(await run(p.a).catch(() => null));
          }
          running = false;
        })();
      }),
    // 还没发出去的作废（松手提交了、换了工具）
    drop: () => {
      waiting?.resolve(null);
      waiting = null;
    },
  };
}

// 最近一次确切预览算了多久：停顿多久才预览按它放长（慢的世界上少算几次）
let lastPreviewMs = 0;

// 停顿多久再预览（毫秒）：至少 base，上次预览算得久就等得久一点（上次的一半），最多 600
// 大世界（6 万格以上，比如类地、大星球；小星球 1.78 万格算得快，不算大世界）：至少停 700 毫秒才算
// （一次预览要一两秒，停顿短时算了也多半被下一笔取消）
export function exactDelay(base: number): number {
  const big = (world.value?.mesh.n ?? 0) > BIG_WORLD;
  return Math.min(big ? 900 : 600, Math.max(base, big ? 700 : 0, 0.5 * lastPreviewMs));
}
const BIG_WORLD = 60000;

// 确切预览的结果：将来的世界。base：按哪个世界算的（世界换了就不再显示）
export interface WorldPreview {
  result: PreviewResult;
  world: World;
  base: World;
}

// Worker 回来的预览：按当前世界的状态算的才用（排在前面的编辑之后算的也算数：那时它的结果已经换上了），
// 过期的丢掉；在当前世界上补上差别，得到将来的世界
export function previewReply(r: Response): WorldPreview | null {
  const base = world.value;
  if (!r.ok || !r.preview || !r.world || !base || r.preview.stateId !== worldState.value) return null;
  const w = previewWorldOf(base, r.world);
  if (r.rivers) seedRivers(w, r.rivers);
  return { result: r.preview, world: w, base };
}

// 最近一次确切预览没算成时 Worker 说的原因（比如资源包里的脚本写错了），按命令记：
// 问的是别的命令（或这条还没算就被更新的换掉了）时为 null，不拿别处的出错冒充这一条的
let worldPreviewFailure: { key: string; error: string } | null = null;
export function worldPreviewError(cmd: Command): string | null {
  const f = worldPreviewFailure;
  return f && f.key === JSON.stringify(cmd) ? f.error : null;
}

const worldPreviews = latest(async (cmd: Command) => {
  const r = await call({ kind: 'previewWorld', cmd }, null);
  worldPreviewFailure = r.ok ? null : { key: JSON.stringify(cmd), error: r.error };
  if (r.ok && r.preview) {
    noteCost(cmd, r.preview.ms);
    lastPreviewMs = r.preview.ms;
  }
  // 预览算不成（比如涂的格都不能长东西）不提示：松手执行时才说
  return previewReply(r);
}, stopRunningPreview);

// 正在算的确切预览不要了：告诉 Worker 在下一个阶段之间停下（星球上一次预览要几秒，新的一笔、要别的值时不必等它算完）。
// 已经发了同一条命令的执行时 Worker 不停（执行直接采用它）。没有在算的预览时什么都不做
function stopRunningPreview() {
  if (!isPending('previewWorld')) return;
  void call({ kind: 'cancelPreview' }, null);
}

// 命令的确切预览，连同将来的世界（previewCommand 不变，画河改道照旧用它）。Worker 留着算好的副本：
// 紧接着执行同一条命令时直接采用，松手后立刻出结果，颜色不跳
export function previewWorld(cmd: Command): Promise<WorldPreview | null> {
  return worldPreviews.ask(cmd);
}

// 还没发出去的作废；hard：正在算的也停下（新的一笔、换了工具）。松手执行时不要 hard：执行同一条命令要直接采用它
// （执行别的命令时 Worker 自己会停下它）
export function cancelWorldPreview(hard = false) {
  worldPreviews.drop();
  if (hard) stopRunningPreview();
}

// Worker 换了一个（卡住后恢复）：排着的、显示着的预览都不要了（按旧 Worker 的状态算的）
function dropPreviews() {
  cancelPreviews();
  worldPreviews.drop();
  provincePreviews.drop();
  terrainOnce.drop();
  terrainPending = null;
  terrainGen++;
  adjustPreview.value = null;
  if (adjustTimer) clearTimeout(adjustTimer);
  adjustTimer = null;
  adjustKey = '';
  adjustPreviewWorld.value = null;
  adjustPreviewNote.value = null;
}

// ---- 调整面板、生态编辑器：拖动停下后预览将来的世界，松手执行同一条命令（直接采用） ----
let adjustTimer: ReturnType<typeof setTimeout> | null = null;
// 正在预览（或要预览）的命令（JSON）
let adjustKey = '';
// 松手后正在执行的命令（JSON）：它的预览世界留到结果换上，关面板也不去掉
let settling = '';

// cmd 为 null：不再预览（关了面板、拖回原来的值）
export function previewAdjust(cmd: Command | null, pause = 200) {
  if (adjustTimer) clearTimeout(adjustTimer);
  adjustTimer = null;
  if (!cmd) {
    adjustKey = '';
    cancelWorldPreview(true);
    if (adjustPreviewWorld.value?.key !== settling) adjustPreviewWorld.value = null;
    adjustPreviewNote.value = null;
    return;
  }
  const key = JSON.stringify(cmd);
  if (key === adjustKey) return;
  adjustKey = key;
  const slow = slowPreview(cmd);
  if (slow !== null) {
    // 不会再有新的预览换上：别的值的预览世界不能留在图上冒充这个值的
    if (adjustPreviewWorld.value?.key !== settling) adjustPreviewWorld.value = null;
    adjustPreviewNote.value = { key, text: slowHint(slow) };
    return;
  }
  adjustPreviewNote.value = { key, text: '正在计算…' };
  adjustTimer = setTimeout(() => {
    adjustTimer = null;
    void previewWorld(cmd).then((r) => {
      if (!r || adjustKey !== key) return;
      adjustPreviewWorld.value = { key, base: r.base, world: r.world };
      adjustPreviewNote.value = { key, text: '地图上是松手后的样子' };
    });
  }, exactDelay(pause));
}

// 松手：执行 cmd。预览的就是它时，预览的世界一直留到结果换上（不先闪回原样），Worker 直接采用预览算好的结果；
// 不是它就先去掉。没有变化、执行失败时（世界没换）也去掉
// note：顶上那句话换成这个、多一个按钮（资源库面板的“已添加 N 项 · 去看看”，第六十七轮）
export async function execAdjust(cmd: Command, label?: string, note?: { head?: string; action?: NoteAction }): Promise<boolean> {
  if (adjustTimer) clearTimeout(adjustTimer);
  adjustTimer = null;
  const key = JSON.stringify(cmd);
  adjustKey = '';
  worldPreviews.drop();
  adjustPreviewNote.value = null;
  if (adjustPreviewWorld.value?.key !== key) adjustPreviewWorld.value = null;
  settling = key;
  try {
    return await exec(cmd, label, note?.action, note?.head);
  } finally {
    if (settling === key) settling = '';
    if (adjustPreviewWorld.value?.key === key) adjustPreviewWorld.value = null;
  }
}

// 换上快照、换了 Worker 时（worker-host.ts 在原来的地方调用）
hostHooks.snapshotSwapped = () => {
  adjustKey = '';
};
hostHooks.dropPreviews = dropPreviews;
