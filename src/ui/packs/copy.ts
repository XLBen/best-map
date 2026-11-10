// 资源库面板上的字（第八十一轮）：同一件事只写一处，叫法见 docs/dev/ui-design.md 的“统一的叫法”

// ---------- 存、导出、删除 ----------
export const SAVE_TO_MINE = '存到我的库';
export const SAVE_TO_MINE_TIP = '别的世界也能用';
export const SAVE_BACK_TIP = (lib: string) => `写回“${lib}”，以后新建世界用这一份`;
export const EXPORT_FILE = '导出文件';
// 整个内置的库复制一份来改（只有整个库才用这个词）
export const COPY_LIBRARY = '复制成我的库';
export const COPY_LIBRARY_TIP = '复制一份来改';
export const DELETE = '删除';
export const DELETE_WORLD_TIP = '从本世界删除；自己做的存到我的库';
export const TIDY = '删除没用到的';
export const TIDY_TIP = '生成后没用到的，地图不变';

// ---------- 看的是哪一份 ----------
export const NOT_WORLD_NOTE = '改这里不影响当前世界';
export const readonlyLine = (name: string) => `这是“${name}”，只能看`;
export const OPEN_IN_WORLD = '在本世界打开';
export const OPEN_IN_WORLD_TIP = '打开本世界里的这一项来改';
export const ADD_TO_WORLD = '添加到本世界…';
export const BACK_TO_WORLD = '回到本世界';

// ---------- 改了什么时候用上 ----------
// 第九十轮：“即时 / 要重新生成 / 只影响新地图”三种标记的字在 timing.ts（TIMING_LABEL、TIMING_TIP）
export const REGEN_BUSY = '正在生成…';
export const regenCountText = (n: number) => `改了 ${n} 项`;
// 顶栏“资源库”按钮旁的小标记（第九十轮）
export const PENDING_TIP = '改了还没用上，点开重新生成';
// 重新生成国家、人文时：国家档案里手写的备注、统治者、大事留着（第八十五轮，规则见 core/human/archive-keep.ts）
export const REGEN_KEEPS_ARCHIVE = '手写的档案留着';

// ---------- 在地图上（第九十轮：一项顶上的一行） ----------
export const ON_MAP = '在地图上';
export const ON_MAP_UNUSED = '没用上';

// ---------- 新建（第九十轮） ----------
// 从“全部文化”新建时选文化组的那一栏下面
export const NEW_IN_WORLD_NOTE = '只列参与生成的组';

// ---------- 从别的库挑（第八十一轮：一种模式） ----------
export const PICK_ENTER = '从别的库添加…';
export const PICK_ENTER_TIP = '挑几项加进来';
export const PICK_DONE = '完成';
export const pickHeadBefore = '从';
export const pickHeadAfter = '挑选';
export const pickPending = (n: number) => `勾了 ${n} 项还没添加`;

// ---------- 生成设置（第八十一轮） ----------
export const GEN_TITLE = '生成设置';
export const GEN_CARD_NOTE = '国家大小、人口、省份大小';
export const GEN_OPEN_TIP = '国家大小、人口、省份大小';
export const GEN_NO_ERA = '还没有生成人文';
export const GEN_POP_NOTE = '总人口 = 人口密度 × 陆地面积';
export const GEN_AFTER_CREATE = '建好后打开生成设置';
// “文化 ⋯”的总人口滑块下面：它和时代的人口密度的关系
export const popDensityNote = (density: number) => `默认按人口密度 ${density} 人/km²；改密度在生成设置`;

// ---------- 撤销 ----------
export const undoTitle = (label: string | null, lib: boolean) => (label ? `撤销 ${label}` : '撤销') + (lib ? '（这个库）' : '') + '（⌘Z）';
export const redoTitle = (label: string | null, lib: boolean) => (label ? `重做 ${label}` : '重做') + (lib ? '（这个库）' : '') + '（⇧⌘Z）';
