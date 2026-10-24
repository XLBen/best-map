// 几处都要讲的同一句话：只写在这里（写法见 docs/开发说明.md 的“文字”）

// 没见过的脚本：打开世界、导入、换星球形态、资源包都问这一句
export const scriptTrustText = (n: number) => `有 ${n} 段没见过的脚本，会在这台电脑上运行。只信任可靠的来源。`;

// 选中的河、湖、地名、省份：名字的几个按钮
export const NAME_TIPS = {
  reroll: '自动换一个名字',
  unlock: '按文字包自动起名',
  lock: '地形再变，名字也不变',
};

// 锁定一条自然的河
export const PIN_RIVER_TIP = '锁定走向，改地形也不挪';

// 河、湖的类型选“自动”
export const byRulesTip = (noun: string) => `按各类型的规则判断是哪一种${noun}`;

// 地图在星球上的位置（向导、调整、帮助）
export const CLIMATE_BELT_NOTE = '越往极地越冷；地图本身跨几个气候带';
