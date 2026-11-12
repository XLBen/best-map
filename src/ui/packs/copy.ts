// 资源库面板上的字（第八十一轮）：同一件事只写一处，叫法见 docs/dev/ui-design.md 的“统一的叫法”

// ---------- 存、导出、删除 ----------
// 第九十二轮：存到我的库只有一个动作、一个去向（save-mine.ts）：一个新建世界时选得到的“我的库”
export const SAVE_TO_MINE = '存到我的库';
export const SAVE_TO_MINE_TIP = '新建世界时选“我的库”就带上';
// 还没有我的库时先说的一句（base：复制哪个库来做它）
export const firstSaveText = (base: string) => `还没有“我的库”：把“${base}”复制一份叫“我的库”，以后存的都放在里面。新建世界时选“我的库”就带上。`;
// “⋯ → 存到我的库…”：这张地图里改过的、自己做的都存
export const SAVE_ALL_TIP = '这张地图里改过的、自己做的都存';
export const saveAllText = (n: number, names: readonly string[], mine: string | null, base: string) =>
  `把这张地图里改过的、自己做的 ${n} 项（${names.join('、')}${n > names.length ? ' 等' : ''}）存到“${mine ?? '我的库'}”。${mine ? `新建世界时选“${mine}”就带上。` : firstSaveText(base)}`;
// 没有时代的库（以前存的）首页上
export const NO_ERA_NOTE = '这个库没有时代，新建世界时选不到';
export const NOT_WHOLE_NOTE = '这个库不够完整，新建世界时选不到';
export const MERGE_TO_MINE = '并进我的库';
export const MERGE_TO_MINE_TIP = '里面的都存到我的库，这个库留着';
// 读进来的文件整个留在资源库里（另成一个库，不是存进我的库）
export const KEEP_FILE = '加进资源库…';
export const KEEP_FILE_TIP = '查过脚本后整个留下，成为一个库';
export const EXPORT_FILE = '导出文件';
// 第九十四轮：我的库的改动没写进浏览器（存储满了、不可用）。改动还在这个页面里，过一阵会再试
export const libNotStored = (name: string) => `“${name}”的改动没能存进浏览器（存储满了或不可用），现在只在这个页面里。请导出库的文件`;
// 整个内置的库复制一份来改（只有整个库才用这个词）
export const COPY_LIBRARY = '复制成我的库';
export const COPY_LIBRARY_TIP = '复制一份来改';
export const DELETE = '删除';
export const DELETE_WORLD_TIP = '从这张地图删除；自己做的先存到我的库';
export const TIDY = '删除没用到的';
export const TIDY_TIP = '生成后没用到的，地图不变';

// ---------- 看的是哪一份（第九十二轮：面板顶上一直写着，source-view.ts） ----------
export const WORLD_NAME = '这张地图';
export const EDITING = '改的是';
export const VIEW_ONLY = '只能看';
export const PICKING_TO = '挑了加到';
export const MINE_EDIT_NOTE = '新世界会用';
export const OPEN_IN_WORLD = '在这张地图里打开';
export const OPEN_IN_WORLD_TIP = '打开这张地图里的这一项来改';
export const ADD_TO_WORLD = '添加到这张地图…';
export const BACK_TO_WORLD = '回到这张地图';
// 来源下拉
export const SOURCE_TIP = '看哪一份';
export const SOURCE_MORE = '更多';
export const SOURCE_MORE_TIP = '直接改我的库、看内置的库、读文件';
export const SOURCE_GROUPS = { mine: '我的库', builtin: '内置的库', imported: '加进来的库', files: '读进来的文件' };
export const NEW_LIBRARY = '新建一个库';
export const READ_FILE = '读文件…';
export const READ_FILE_TIP = '读一个库的文件，不运行脚本';

// ---------- 搜索（第九十二轮：这张地图的首页也有） ----------
export const SEARCH_WORLD = '搜索这张地图里的内容';
export const SEARCH_LIB = '搜索整个库';
export const SEARCH_TIP = '名字、外文名都能搜';

// ---------- 改了什么时候用上 ----------
// 第九十轮：“即时 / 要重新生成 / 只影响新世界”三种标记的字在 timing.ts（TIMING_LABEL、TIMING_TIP）
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
// 第九十二轮：挑选时每一步一句人话（pick-help.ts）
export const PICK_HELP = '勾要的，再点右边的“添加”。灰的行写着为什么不能选';
export const BASKET_HELP = '下面这些会一起加进来；点 × 去掉';
export const HAVE_NOTE = '已经有了';

// ---------- 生成设置（第八十一轮） ----------
export const GEN_TITLE = '生成设置';
export const GEN_CARD_NOTE = '国家大小、人口、省份大小';
export const GEN_OPEN_TIP = '国家大小、人口、省份大小';
export const GEN_NO_ERA = '还没有生成人文';
// 第九十三轮：国家等级的比例下面的一句（以前的“统一 ↔ 分裂”滑块第七十七轮去掉了，现在调的就是这条比例和国家大小）
export const GEN_TIERS_NOTE = '帝国、王国占得多，大国就多；小国占得多，更分裂';
export const GEN_REGEN_NOTE = '这几项改完要点底下的“重新生成”';
export const genMore = (what: string) => `${what}的更多设置`;
export const GEN_AFTER_CREATE = '建好后打开生成设置';
// “文化 ⋯”的总人口滑块下面：它和时代的人口密度的关系
export const popDensityNote = (density: number) => `默认按人口密度 ${density} 人/km²；改密度在生成设置`;

// ---------- 撤销 ----------
export const undoTitle = (label: string | null, lib: boolean) => (label ? `撤销 ${label}` : '撤销') + (lib ? '（这个库）' : '') + '（⌘Z）';
export const redoTitle = (label: string | null, lib: boolean) => (label ? `重做 ${label}` : '重做') + (lib ? '（这个库）' : '') + '（⇧⌘Z）';
