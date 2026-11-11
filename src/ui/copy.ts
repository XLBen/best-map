// 几处都要讲的同一句话：只写在这里（写法见 docs/开发说明.md 的“文字”）

// 资源库：顶栏、“世界”菜单写它是什么
export const LIBRARY_NOTE = '这张地图和各个库里的文化、政体、生态、河湖、地名风格……';
// 工具的选择器、缺内容的提示：去库里找
export const LIBRARY_ADD_LABEL = '从资源库添加…';
export const LIBRARY_ADD_TIP = '库里还有的，添加到这张地图后就能选';

// 第九十二轮：地图上点到的东西（档案、“这里”卡片）直达资源库里的那一项；名字、颜色在那一行上直接改
export const OPEN_IN_LIBRARY = '在资源库里打开';
export const OPEN_IN_LIBRARY_TIP = '打开这张地图里的这一项';
export const QUICK_EDIT_TIP = '改的是这一种，用到它的都变';
export const IN_LIBRARY_TITLE = '在资源库里';
// 新建向导：有我的库时写一句
export const WIZARD_MINE_NOTE = '“我的库”里有你存过的内容';

// 没见过的脚本：打开世界、导入、换星球形态、资源包都问这一句（写在 trust.ts：state.ts 也用，它不引用界面）
export { scriptTrustText } from '../trust';

// 选中的河、湖、地名、省份：名字的几个按钮
export const NAME_TIPS = {
  reroll: '自动换一个名字',
  unlock: '按地名风格自动起名',
  lock: '地形再变，名字也不变',
};

// 锁定一条自然的河
export const PIN_RIVER_TIP = '锁定走向，改地形也不挪';

// 河、湖的类型选“自动”
export const byRulesTip = (noun: string) => `按各类型的规则判断是哪一种${noun}`;

// 地图在星球上的位置（向导、调整、帮助）
export const CLIMATE_BELT_NOTE = '越往极地越冷；地图本身跨几个气候带';

// 给世界加一个变量
export const ADD_DIMENSION_NOTE = '文化、国家、城市都不会变。想让国家用上它，点“重新生成国家”';

// 总表上写了规则（脚本）的河湖：规则说是的里面再看这张表
export const SCRIPT_RIVER_NOTE = '带“规则”的先看规则，规则说是的再按这里的勾一格一格看';
// 不自然生成的河湖
export const WATER_MANUAL_NOTE = '不自然生成：勾了也不会自己出现，只用在画的、选了它的上面';

// 地貌的季节和风的季节是两个
export const SEASON_NOTE = '只改雪和植被的样子。风向有自己的季节，在左下角的图例里';

// 生成人文、国家的面板（第七十七轮）：生成的参数都在资源库里
export const GEN_RULES_NOTE = '国家大小、人口在资源库里改';
export const ERA_PAGE_TIP = '打开资源库里的时代';

// 省份面板（第七十八轮）：省份划分的规则在资源库里
export const PROVINCE_RULES_NOTE = '省份多大在“生成设置”里改';
export const PROVINCE_RULES_TIP = '打开资源库里这张地图的省份划分';

// 国家档案里的备注、统治者、家族、大事（第八十五轮）
export const ARCHIVE_TEXT = {
  note: '备注',
  notePlaceholder: '这一国的设定、故事……',
  rulers: '统治者',
  addRuler: '加统治者',
  newRuler: '新统治者',
  addDynasty: '加家族',
  newDynasty: '新家族',
  noDynasty: '不属于家族',
  dynasty: '家族',
  // 第九十一轮：没改过的称号跟着政体变；改成空的恢复自动
  titlePlaceholder: '空着跟着政体',
  parent: '父母',
  noParent: '没写',
  title: '称号',
  orig: '原文',
  reign: '在位',
  now: '至今',
  earlier: '往前',
  later: '往后',
  remove: '删除',
  more: '更多',
  timeline: '大事年表',
  addEvent: '加大事',
  newEvent: '新的大事',
  linked: '牵涉',
  addLinked: '加一国',
  // 说明（悬停、灰字，不超过 20 个字）
  rulersHint: '最后一位是现在的统治者',
  reignHint: '结束空着是至今',
  fromRuler: '跟着统治者的名单改',
  fromFounded: '跟着建国的年份改',
  current: '现在的统治者',
} as const;

// 留着的旧世界（第九十一轮）：上次的世界这一版打不开时，一直在的那一条、向导上面的一块、“世界”菜单里的一行、列表
export const BACKUP_TEXT = {
  older: '上次的世界是旧版本做的，这一版打不开。它还留着',
  newer: '上次的世界是更新的版本做的，这一版打不开。它还留着',
  // 第九十四轮：这一版的世界也会留着——没存完整的、没能打开的、没打开的、别的页面里保存的、被换掉的
  why: {
    damaged: '上次的世界没存完整，打不开。存下的部分还留着',
    failed: '上次的世界没能打开。它还留着',
    cancelled: '上次的世界没有打开。它还留着',
    'other-page': '另一个页面里保存的世界和这里的不一样。它还留着',
    replaced: '原来自动保存的世界被换掉了。它还留着',
  },
  // 列表里一行灰字的最后一段
  whyRow: {
    damaged: '没存完整',
    failed: '没能打开',
    cancelled: '上次没有打开',
    'other-page': '另一个页面里保存的',
    replaced: '被换掉之前的',
  },
  export: '导出文件',
  exportTip: '原样存成世界文件',
  open: '打开',
  menu: '留着的旧世界…',
  menuHint: (n: number) => `${n} 个留着的世界：能导出、删除`,
  title: '留着的旧世界',
  hint: '打不开的、被换掉之前的世界原样留在这里，能导出成世界文件',
  empty: '没有留着的旧世界',
  deleteTitle: '删除留着的旧世界',
  deleteText: '删除后找不回来。想留一份就先导出文件。',
  where: '以后在“世界 → 留着的旧世界”里找',
} as const;

// 自动保存（第九十四轮）：这个世界开在另一个页面里时一直在的一条、没存成时顶栏“世界”上的记号和“世界”菜单的第一行
export const SAVE_TEXT = {
  otherPage: '这个世界已在另一个页面打开，这个页面里的改动不会自动保存',
  takeOver: '在这里接着做',
  takeOverTip: '改由这个页面自动保存，另一个页面不再保存',
  tookOver: '这个页面接着自动保存',
  export: '导出文件',
  exportTip: '把这个页面里的世界存成世界文件',
  // 第九十五轮：写的那一页关了，但它存下的比这个页面里的新——主要的按钮是“重新载入”
  stalePage: '另一个页面里保存了更新的世界，这个页面里的是旧的，改动不会自动保存',
  reload: '重新载入',
  reloadTip: '打开保存的那一份。这个页面里的样子先留一份',
  reloadKept: '这个页面里原来的样子留在“以前的版本”里',
  reloadNotKept: {
    title: '这个页面里的样子没能留下来',
    text: '浏览器存储满了或不可用。重新载入以后，这个页面里的改动找不回来；想留着就先导出文件。',
    go: '重新载入',
    export: '导出文件',
    cancel: '取消',
  },
  // 顶栏“世界”旁的小标记
  badge: '没保存',
  // 没存成时顶上说一次的话、“世界”菜单第一行的话：发生了什么、现在能做什么
  problem: {
    quota: '浏览器存储满了，这张地图没能自动保存。请导出世界文件，或删除几张旧地图',
    unavailable: '浏览器存储不可用（可能是隐私模式），这张地图没能自动保存。请导出世界文件',
    'too-big': '这张地图太大，浏览器存储不可用时存不下。请导出世界文件',
    'other-page': '这个世界已在另一个页面打开，这个页面里的改动不会自动保存',
    'stale-page': '另一个页面里保存了更新的世界，这个页面里的是旧的，改动不会自动保存。请重新载入',
  },
  // 标记的悬停
  tip: {
    quota: '没保存：浏览器存储满了',
    unavailable: '没保存：浏览器存储不可用',
    'too-big': '没保存：这张地图太大',
    'other-page': '没保存：已在另一个页面打开',
    'stale-page': '没保存：这个页面里的是旧的',
  },
  tight: '浏览器给的存储快满了。请导出世界文件，或删除几张旧地图',
} as const;

// 以前的版本（第九十五轮）：“世界”菜单里的一行、“我的地图”每张上的按钮、列表、回到某一份
export const VERSION_TEXT = {
  menu: '以前的版本…',
  menuHint: (n: number) => `自动留了 ${n} 份，能回到那时的样子`,
  menuNone: '还没有。改动以后自动留',
  title: '以前的版本',
  titleOf: (name: string) => `“${name}”以前的版本`,
  hint: '改动时自动留，越早的留得越稀。回到某一份之前，现在的样子也先留一份',
  empty: '还没有以前的版本',
  // 没存进“我的地图”、现在也没开着的世界
  others: '没存进“我的地图”的世界',
  othersHint: '换世界之前没保存的，最后的样子在这里',
  restore: '回到这一份',
  restoreTip: '现在的样子先留一份，再换成这一份',
  open: '打开',
  openTip: '打开这个世界那时的样子',
  export: '导出文件',
  exportTip: '把这一份存成世界文件',
  deleteTitle: '删除这一份',
  deleteText: '删除后找不回来。现在的地图和别的几份不受影响。',
  restored: (when: string) => `已回到 ${when} 的样子。回去之前的样子也留了一份`,
  opened: (when: string) => `已打开 ${when} 的样子`,
  gone: '这一份已经不在了',
  failed: '没能打开这一份',
  steps: (n: number) => `${n} 步`,
  // 列表里一行灰字的最后一段：为什么留的（平常隔一阵留的不写）
  why: {
    auto: '',
    opened: '打开时的样子',
    'before-restore': '回去之前留的',
    replaced: '被换掉之前留的',
    'before-reload': '重新载入之前留的',
  },
  // 回去之前现在的样子没能留下来（存储满了、不可用）：先问
  notKept: {
    title: '现在的样子没能留下来',
    text: '浏览器存储满了或不可用。回到这一份以后，现在的样子找不回来；想留着就先导出文件。',
    go: '仍然回去',
    export: '导出文件',
    cancel: '取消',
  },
  // 别的页面往同一张地图里存过：盖掉之前留了一份
  replaced: (name: string) => `“${name}”在另一个页面里保存过。那一份留在“以前的版本”里`,
  mapButton: '版本',
  mapButtonTip: '这张地图以前的版本',
} as const;

// 存到电脑上的文件（第九十五轮）：“世界”菜单里的一行和状态、没在写时顶上的一条、没写成时的记号
export const FILE_TEXT = {
  menu: '存到电脑上的文件…',
  menuHint: '选一个文件，以后保存时也写进它',
  menuAgain: '换一个文件…',
  unsupported: '这个浏览器不支持。请用下面的“世界文件”导出',
  // 状态一行
  on: (name: string, when: string) => `也存在电脑上：${name} · ${when}`,
  notYet: '还没写',
  paused: (name: string) => `没在写文件：${name}`,
  resume: (name: string) => `接着存到 ${name}`,
  resumeTip: '浏览器要重新确认一次能写这个文件',
  stop: '不再存到这个文件',
  stopTip: '文件留在原处，以后不再写它',
  stopped: (name: string) => `不再存到“${name}”。文件还在原处`,
  attached: (name: string) => `以后保存时也写进“${name}”`,
  resumed: (name: string) => `接着存到“${name}”`,
  pickFailed: '没能打开选文件的窗口。请用“世界文件”导出',
  // 没在写时顶上一直在的一条
  pausedBanner: (name: string) => `这张地图也存在电脑上的“${name}”，现在没在写`,
  // 没写成：顶栏的记号、悬停、“世界”菜单第一行（发生了什么、现在能做什么）
  badge: '文件没写',
  tip: {
    gone: '文件没写：找不到那个文件',
    denied: '文件没写：不能写那个文件',
    full: '文件没写：磁盘满了',
    failed: '文件没写：没写成',
  },
  fail: {
    gone: (name: string) => `电脑上的“${name}”找不到了，没能写进去。浏览器里的这一份还在。请换一个文件`,
    denied: (name: string) => `不能写电脑上的“${name}”，没能写进去。浏览器里的这一份还在。请点“接着存到 ${name}”`,
    full: (name: string) => `磁盘满了，“${name}”没能写进去。浏览器里的这一份还在。请腾出空间，或换一个文件`,
    failed: (name: string) => `“${name}”没能写进去。浏览器里的这一份还在。请换一个文件，或导出世界文件`,
  },
} as const;

// 撤销到头了（第九十五轮）：更早的步骤的撤销记录为了省内存丢掉了
export const UNDO_LIMIT_TEXT = {
  tip: '更早的步骤不能撤销了（为了省内存）',
  history: (n: number) => `前 ${n} 步不能撤销了（为了省内存），世界文件里都还在`,
} as const;
