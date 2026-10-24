import type { ScriptKind } from '../../core/script';

// 脚本框“变量和例子”里每种脚本的几段例子（变量用中文名；测试检查它们都能通过编辑器的检查）
export const SCRIPT_EXAMPLES: Record<ScriptKind, { label: string; src: string }[]> = {
  placement: [
    { label: '只长在高处', src: '// 海拔 1500 米以上才长，越高越多\nreturn smoothstep(1500, 2500, 海拔);' },
    { label: '一片一片地长', src: '// 用噪声分成一块一块的：数越大，块越小越碎\nreturn smoothstep(0.1, 0.3, fbmAt(3, 3));' },
    { label: '离河近的地方', src: '// 离河越近越多，200 千米以外不长\nreturn 1 - smoothstep(0, 200, 离河);' },
    { label: '只在北半球', src: 'return 纬度 > 0;' },
  ],
  color: [
    { label: '越高越白', src: '// 越高越接近白色\nreturn mixColor(颜色, [240, 240, 240], smoothstep(1000, 3000, 海拔));' },
    { label: '深深浅浅', src: '// 每格随机地深一点或浅一点\nconst k = 0.85 + 0.3 * rand();\nreturn [颜色[0] * k, 颜色[1] * k, 颜色[2] * k];' },
    { label: '越干越黄', src: "return mixColor(颜色, '#c8b060', 1 - smoothstep(0.3, 1.2, 湿润));" },
  ],
  match: [
    { label: '高山上的河', src: '// 整条河的平均海拔在 1500 米以上\nreturn 海拔 > 1500;' },
    { label: '大河', src: '// 流量是河流门槛的 10 倍以上\nreturn 流量 > 10 * 河流门槛;' },
    { label: '从雪山上流下来', src: '// 源头在 3000 米以上\nreturn 源头海拔 > 3000;' },
    { label: '长河、一段一段的', src: '// 500 千米以上的长河，再用噪声挑出一部分\nreturn 河长 > 500 && fbmAt(2, 2) > 0;' },
  ],
  crust: [{ label: '两极抬高', src: '// 纬度 55° 以上慢慢抬高，最多 900 米\nconst polar = smoothstep(55, 80, Math.abs(纬度));\nreturn { height: 高度 + 900 * polar };' }],
  setup: [{ label: '再加一块大陆', src: 'addBlock({ lat: 30, lon: 60, size: 25 });' }],
};

// 湖泊类型的 match（第九轮）：“变量和例子”在湖的编辑器里换成这几段（河的那几段用到河长、源头海拔，湖里没有）
export const LAKE_MATCH_EXAMPLES: { label: string; src: string }[] = [
  { label: '高山上的湖', src: '// 整个湖的平均海拔在 2000 米以上\nreturn 海拔 > 2000;' },
  { label: '大湖', src: '// 连干涸的湖底 5000 平方千米以上\nreturn 湖面积 > 5000;' },
  { label: '干湖', src: '// 只剩干涸的湖底\nreturn 干湖 === 1;' },
  { label: '热地方的湖、一片一片的', src: '// 年均温 20 °C 以上，再用噪声挑出一部分\nreturn 年均温 > 20 && fbmAt(2, 2) > 0;' },
];
