import type { Command, RemovedItem } from '../core/commands';
import type { ContentRef } from '../core/content/unused';
import type { TidyPlan } from '../core/tidy';
import type { CompactResult } from '../core/compact';
import type { DocTail, PreviewResult, ProvincesPreview, Timings, WorldDoc } from '../core/engine';
import type { ExportOptions, ExportPartId } from '../core/export';
import type { WorldgenInput } from '../core/generate';
import type { PreviewPatch } from '../core/preview-world';
import type { PackedRivers } from '../core/river-pack';
import type { TerrainPatch, TerrainPreview } from '../core/terrain';
import type { GeoFeature } from '../core/features';
import type { ScriptIssue } from '../core/script';
import type { Causes, Derived, Settings, SmallState } from '../core/world';
import type { PostedContent } from './content-post';
import type { PostedRegenBase } from '../core/regen-base';

// 主线程与计算 Worker 之间的消息

// safe：安全模式（脚本不运行）。一个 Worker 从第一次新建、打开起就固定是不是安全模式，换模式时主线程另开一个 Worker。
// build：这个程序的版本（检查点按它认；打包好的程序里是引擎文件的地址，文件名带内容哈希）。由主线程告诉 Worker：
//   隔离的 Worker 是从 data: 地址开的，拿不到自己的文件地址。没有时（开发时）不写检查点。
// store：通往存储 Worker 的端口（主线程给的，新建、打开时各给一个新的；安全模式、开发时没有）。打开时存储 Worker 先从这里
//   发来一条：对得上这个世界的检查点，或者 null；之后写好的检查点从这里直接发给存储 Worker（不经过主线程），
//   主线程只收一条步号的通知（CheckpointReady），核对后让存储 Worker 写下。
//   只在发出去的那一刻带上（端口转移后就不能再发），主线程留着的请求里没有它
export type Request =
  | { kind: 'init'; settings: Partial<Settings>; commands?: Command[]; safe?: boolean; build?: string; store?: MessagePort }
  | { kind: 'load'; doc: WorldDoc; safe?: boolean; build?: string; store?: MessagePort }
  | { kind: 'exec'; cmd: Command }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'preview'; cmd: Command }
  // 省份命令的轻预览：只算省份（重划、按新规则重新划分之前先看新的省界和省名）
  | { kind: 'previewProvinces'; cmd: Command }
  // “调整”面板拖滑块时：只组合地形，返回陆海的变化
  | { kind: 'previewTerrain'; patch: TerrainPatch }
  // 预览，连同将来的世界（与当前世界的差别）：地图画出将来的样子
  | { kind: 'previewWorld'; cmd: Command }
  // 不要正在算的确切预览了（新的一笔、换了工具、要的是别的值）：Worker 在下一个阶段之间停下它（那个预览回 cancelled）。
  // 已经收到同一条命令的执行时不停（执行要直接采用它）。立即回复，不排队
  | { kind: 'cancelPreview' }
  // 第九十七轮：不要正在算的这一步了（“取消”）。编号不超过 upTo 的执行、撤销、重做、换一个：正在算的在下一个阶段之间停下、
  // 世界原样退回（引擎照“中途出错”的路，重做记录还在），排着还没算的不算了——都回 {ok:false, soft:true}。
  // 新建、打开不走这里（主线程直接结束这个 Worker，见 sandbox.ts 的 stopAny）。立即回复，不排队
  | { kind: 'cancel'; upTo: number }
  // 换一个：撤掉最后一步并执行新命令
  | { kind: 'replaceLast'; cmd: Command }
  | { kind: 'doc' }
  // 自动保存：只要已存的步之后变了的命令
  | { kind: 'docTail'; ids: number[] }
  // 页面要被隐藏、关掉：立即写检查点
  | { kind: 'checkpoint' }
  // 要一份完整的快照（主线程拼不起只带变了的数组的快照时）
  | { kind: 'snapshot' }
  // 新建向导：用少量格子快速生成一张缩略图（一张一张要，画好一张显示一张）
  // content（第三十轮）：生成之前先执行的命令（新世界默认加的生态、基础……；计算 Worker 里没有内置的内容）
  | { kind: 'thumb'; settings: Partial<Settings>; gen: WorldgenInput; width: number; height: number; content?: Command[] }
  // 整理本世界的计划（第二十九轮）：在世界的副本上试，世界不变。only：只考虑这几项（“清理没用到的”列的）
  | { kind: 'planTidy'; only?: ContentRef[] };

// small、contentRev、sameContent：内容没换时不发（见 content-post.ts）
export interface Snapshot extends PostedContent {
  settings: Settings;
  causes: Causes;
  derived: Derived;
  history: { summary: string; done: boolean }[];
  canUndo: boolean;
  canRedo: boolean;
  // 第九十五轮：最前面几步不能撤销了（撤销记录为了省内存丢掉了，见 core/undo-budget.ts）；没有时不带
  undoLocked?: number;
  timings: Timings;
  // 引擎的状态编号（预览按它判断过没过期）
  stateId: number;
  // 只带变了的推导数组（第九轮）：same 里列出的数组与上一次发的内容相同，没有发（derived、corrF 里那一项是 null），
  // 主线程沿用自己手上的那一个（同一个数组对象，着色、河线的缓存照样命中）。base 是上一次发快照时的状态编号：
  // 主线程的世界不是那个状态时拼不起来，要一份完整的（snapshot 请求）。没有 same 时是完整的快照
  // rows：变了一小部分格的推导数组（比如冷暖画笔只动了一片的份额、适宜度）：只带变了的格（idx 是格，rows 依次是它们的值，
  // 每格 数组长度 / 格数 个），derived 里那一项也是 null，主线程在自己那一份的副本上补上
  // causes、fields（第八十轮）：原因数组、自定义场里与上一次发的内容相同的（causes、causes.fields 里那一项是 null），同样沿用主线程手上的；
  // objects：推导里不是数组的（地物）与上一次发的逐值相同的，derived 里那一项是 null
  same?: { base: number; derived: string[]; corrF: string[]; rows: Record<string, { idx: Int32Array; rows: ArrayBufferView }>; causes?: string[]; fields?: string[]; objects?: string[] };
  // 地图上的河（河线与带子，第十三轮）：Worker 描好打包转交，主线程拆开直接用（见 core/river-pack.ts）
  rivers?: PackedRivers;
  // 这一份河的编号（第八十轮）：和上一次发的相同时不带 rivers，主线程用手上拆好的那一份
  riversId?: number;
}

// 轻快照：只改了名字、省份（推导没有重算）时只发这些，推导数组沿用主线程上已有的
export interface LightSnapshot extends PostedContent {
  light: true;
  // 第八十轮：与上一次发的相同时为 null（主线程沿用手上的）
  features: GeoFeature[] | null;
  province: Int32Array;
  // 每格的岛的种类（第十四轮：删掉一种岛时编号会挪，只重新起名的一步也要带上）
  islandType: Uint8Array;
  history: { summary: string; done: boolean }[];
  canUndo: boolean;
  canRedo: boolean;
  // 第九十五轮：最前面几步不能撤销了（撤销记录为了省内存丢掉了，见 core/undo-budget.ts）；没有时不带
  undoLocked?: number;
  timings: Timings;
  stateId: number;
}

// 导出 Worker：一次导出一个世界；进度消息之后是结果
export interface ExportJob {
  settings: Settings;
  causes: Causes;
  small: SmallState;
  derived: Derived;
  doc: WorldDoc;
  opts: ExportOptions;
  // 分开导出的一项（第二十四轮）：只写这一项的文件（表、档案全文、道路图），不打包
  part?: { id: ExportPartId; width: number; height: number };
}

// 导出 Worker 的另一件事（第二十九轮）：压缩世界文件（导出世界、存进“我的地图”时）。要重放两遍，不放在计算 Worker 里。
// 这个 Worker 不隔离：世界里有不是内置的脚本时不压缩（回 skipped），原样写出去
export interface CompactJob {
  compact: WorldDoc;
}
export type CompactReply = { ok: true; compacted: Pick<CompactResult, 'doc' | 'changed' | 'verified' | 'dropped'> } | { ok: true; skipped: string } | { ok: false; error: string };

// warnings：导出时要告诉用户的话（比如极小的省在切线附近分不到像素）
export type ExportReply = { progress: number } | { ok: true; zip: Uint8Array; warnings?: string[] } | { ok: true; files: Record<string, Uint8Array> } | { ok: false; error: string };

// 主线程保存的命令记录（Worker 卡住、崩了时用它恢复世界）：执行、撤销、重做、换一个、新建、打开的回复都带上
// 上次回复以来变了的命令（engine.docTail）。epoch：Worker 里的引擎换一个（新建、打开）就加一，那时 from 为 0
export interface MirrorLog extends DocTail {
  epoch: number;
}

// Worker 主动发来的消息（没有 id）：脚本开始运行、还在算（最多每 250 毫秒一次）、算完（含出错）。
// 主线程的看门狗只在脚本运行期间计时（见 sandbox.ts）
export interface ScriptPing {
  kind: 'script';
  phase: 'enter' | 'tick' | 'exit';
  // 谁的脚本（生态名……）
  label: string;
}

// Worker 主动发来的消息（不是回复，没有 id）：带提示的一步（新建、打开、执行、撤销、重做、换一个）走到哪了（第九十七轮）。
// 和脚本的那一条走同一条路（sandbox.ts 的 readWorkerMessage 检查，EngineHost 交给界面）。只在步的边界上发（见 core/progress.ts）。
//   req：是哪一个请求的（那个请求的编号；不叫 id——带 id 的只有回复）；step：这一步的名字（core/progress.ts 列着；另有 Worker 自己说的 mesh 建网格、restore 从检查点恢复、
//   replay 重放命令）；k、n：这一串里的第几步、共几步（重放时是第几条命令、共几条）；
//   inner：重放命令时里面的小步（流水线、生成人文的各步）——只当名字看，数第几步看 replay 的那几条
export interface StagePing {
  kind: 'stage';
  req: number;
  step: string;
  k: number;
  n: number;
  inner?: boolean;
}

// 计算 Worker 开起来、自查完之后发的第一条消息（没有 id）：是不是在隔离的环境里（三项检查全部通过，见 isolation-probe.ts）。
// 主线程只认 data: 地址开的 Worker 的第一条招呼
export interface Hello {
  kind: 'hello';
  isolated: boolean;
}

// 计算 Worker 写好了一个检查点（没有 id）：检查点本身已经从 store 端口直接发给存储 Worker，这里只有纪元和步号。
// 主线程核对步号与命令记录一模一样，才让存储 Worker 写下（见 sandbox.ts、checkpoint-store.ts）
export interface CheckpointReady {
  kind: 'checkpointReady';
  epoch: number;
  ids: number[];
}

export type Response =
  | {
      id: number;
      ok: true;
      summary?: string;
      log?: MirrorLog;
      // 这个 Worker 是安全模式（新建、打开的回复里带）
      safe?: boolean;
      // 命令什么都没改：没有快照，也没有进历史
      noop?: boolean;
      // 这一步移出世界的内容（第二十九轮，exec 的回复里带；没有时不写）
      removed?: RemovedItem[];
      // 缺了内容跳过的步骤（第三十轮，exec、新建 init 的回复里带；没有时不写）：“没有城市等级：没有放城市和道路”……
      skipped?: string[];
      // 每一样上一次生成时的内容（第九十轮；新建、打开、撤销、重做的回复里带）：只带和这一份快照的内容不一样的项
      regen?: PostedRegenBase;
      // 确切预览没算完就被取消了（没有 preview、world）
      cancelled?: boolean;
      snapshot?: Snapshot | LightSnapshot;
      preview?: PreviewResult;
      provinces?: ProvincesPreview;
      terrain?: TerrainPreview;
      // 预览世界：与当前世界的差别（previewWorld）
      world?: PreviewPatch;
      // 预览世界的河（Worker 描好的，第十三轮）
      rivers?: PackedRivers;
      doc?: WorldDoc;
      tail?: DocTail;
      thumb?: Uint8ClampedArray;
      // 整理本世界的计划（planTidy 的回复）
      tidy?: TidyPlan;
      // 缩略图里星球形态的脚本出的错（thumb 的回复里，有形态时才有）
      issues?: ScriptIssue[];
    }
  // stopped（第九十六轮）：用户点了“取消”（那时叫“停止”），这个请求没算完就被停下了。
  // soft（第九十七轮）：是计算程序自己在阶段之间停的（引擎原样退回，重做记录还在；Worker 还是那一个）；
  // 没有 soft 的 stopped 是主线程结束了这个 Worker、替它回的（sandbox.ts 的 stopAny：世界用命令记录另开一个恢复）。
  // Worker 说的 soft 只有主线程确实要它取消过这一个请求时才作数（EngineHost.receive）
  | { id: number; ok: false; error: string; stopped?: boolean; soft?: boolean };
