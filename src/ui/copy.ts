// 几处都要讲的同一句话：只写在这里（写法见 docs/开发说明.md 的“文字”）

// 资源库：顶栏、“世界”菜单写它是什么
export const LIBRARY_NOTE = '本世界和各个库里的文化、政体、生态、河湖、地名风格……';
// 工具的选择器、缺内容的提示：去库里找
export const LIBRARY_ADD_LABEL = '从资源库添加…';
export const LIBRARY_ADD_TIP = '库里还有的，添加到本世界后就能选';

// 没见过的脚本：打开世界、导入、换星球形态、资源包都问这一句
export const scriptTrustText = (n: number) => `有 ${n} 段没见过的脚本，会在这台电脑上运行。只信任可靠的来源。`;

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
