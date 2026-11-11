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
  export: '导出文件',
  exportTip: '原样存成世界文件',
  open: '打开',
  menu: '留着的旧世界…',
  menuHint: (n: number) => `${n} 个这一版打不开的世界：能导出、删除`,
  title: '留着的旧世界',
  hint: '这一版打不开的世界原样留在这里，能导出成世界文件',
  empty: '没有留着的旧世界',
  deleteTitle: '删除留着的旧世界',
  deleteText: '删除后找不回来。想留一份就先导出文件。',
  where: '以后在“世界 → 留着的旧世界”里找',
} as const;
