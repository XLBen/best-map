import { signal } from '@preact/signals';
import { brushRangeKm, defaultIslandKm, lakeRangeKm, mapScaleKm, reachRangeKm, roundKm } from '../../core/terrain';
import type { World } from '../../core/world';

// 工具的选项（第七十轮从 state.ts 分出来）：画笔多大、放什么岛、画什么河……；新世界时大小类的跟着地图尺度走

export interface ToolOptions {
  // 画笔半径（km），所有画笔共用
  brushKm: number;
  landMode: 'land' | 'sea';
  // 画陆地：用画笔涂，还是圈一片
  landShape: 'brush' | 'lasso';
  reliefMode: 'up' | 'down';
  // 堆山的力度（抬升量）
  reliefAmount: number;
  // 涂地形类别时地面跟着变多少（第五十八轮）：0 只改类别；默认 0.5：一笔走缺的高度的两到四成，看得出变化，多涂几笔接近典型高度
  classStrength: number;
  // 放岛用哪一种岛（内置的或自己的岛的种类的 id，见 core/island-types.ts；种类被删了时按大陆岛，见 ui/panels/islandTypes.tsx 的 liveIslandKind）
  islandKind: string;
  // 岛的海岸线半径（km）
  islandKm: number;
  // 岛链有自己的种类和大小（没有小礁），放岛时选小礁不影响岛链
  chainKind: string;
  chainKm: number;
  chainDensity: number;
  // 岛链里碎岛的比例（第十八轮，0–1）
  chainFrag: number;
  // 打碎（第十八轮）：裂成碎块还是只打碎海岸，力度 0.1–1
  fragMode: 'blocks' | 'coast';
  fragAmount: number;
  biome: string | null;
  biomeMode: 'natural' | 'force';
  // 自然融入时周围跟着变的范围（km）
  reachKm: number;
  tempMode: 'cold' | 'warm';
  moistMode: 'wet' | 'dry';
  // 冷暖、干湿各自的力度：1 相当于升降 4 °C、雨水多少约四成
  tempAmount: number;
  moistAmount: number;
  // 湖的半径（km）
  lakeKm: number;
  // 画的河有多大：一路加进来的水合计为“河流多少”门槛的几倍
  riverFlow: number;
  // 画河：顺地势（点源头，河自己找路），还是自定义走向（按住画出河道，河照着走）
  riverMode: 'flow' | 'course';
  // 画的线停在陆地上时：流下去（顺着地势接着流），还是停在这（河在那里结束）
  riverEnd: 'flow' | 'sink';
  // 新画的河是哪一种（河流类型的 id；'' 按各类型的规则判断；'plain' 普通的河）
  riverType: string;
  // 新放的湖是哪一种（同上，湖泊类型）
  lakeType: string;
  // 正在涂的自定义场
  field: string | null;
  fieldMode: 'add' | 'sub';
  fieldAmount: number;
  // 画地形类别（第二十一轮）：类别的 id，'' 恢复自动
  terrainClass: string;
  // 画资源：资源的 id，'none' 明确没有，'' 恢复自动
  resource: string;
  // 文化笔刷（第二十二轮）：文化的 id（'' 还没选：用世界里第一个），力度（每笔换掉多少人，0–1），
  // keep：只换文化、别的维度不变；typical：换成这个文化最典型的群体
  culture: string;
  cultureAmount: number;
  cultureMode: 'keep' | 'typical';
  // 人口笔刷：改成分 / 改人数 / 改一个维度
  popMode: 'share' | 'count' | 'value';
  // 改成分的群体（文化 + 每一维的取值；null 还没选：用这里最多的人）
  popTuple: { culture: string; values: Record<string, string> } | null;
  // 改成分、改一个维度的力度（−1–1，第二十七轮：负值是往外推、这一类减少）
  popAmount: number;
  // 改人数：增减的比例（第二十七轮：−0.9–3，倍数 = 1 + popPercent；Shift 反过来）
  popPercent: number;
  // 改一个维度：维度的 id、取值的 id（'' 还没选：用第一维、第一个取值）
  popDim: string;
  popValue: string;
  // 领土笔刷（第二十三轮）：涂给哪个国家（编号；0 是无主地，-1 还没选：用选中的国家或最大的那个）
  territory: number;
  // 新建国家：点一个省份，还是圈一片
  newCountryShape: 'province' | 'lasso';
  // 第二十四轮：新画的道路是大道还是小路；放地标、自定义点用哪一种；当作城市的点挂不挂在附近的城市上
  roadKind: 'major' | 'minor';
  landmarkType: string;
  pointType: string;
  pointAttach: boolean;
}

export const options = signal<ToolOptions>({
  brushKm: 200,
  landMode: 'land',
  landShape: 'brush',
  reliefMode: 'up',
  reliefAmount: 0.7,
  classStrength: 0.5,
  islandKind: 'continental',
  islandKm: 100,
  chainKind: 'continental',
  chainKm: 100,
  chainDensity: 1,
  chainFrag: 0,
  fragMode: 'blocks',
  fragAmount: 0.5,
  biome: null,
  biomeMode: 'natural',
  reachKm: 400,
  tempMode: 'cold',
  moistMode: 'wet',
  tempAmount: 1,
  moistAmount: 1,
  lakeKm: 40,
  riverFlow: 4,
  riverMode: 'flow',
  riverEnd: 'flow',
  riverType: '',
  lakeType: '',
  field: null,
  fieldMode: 'add',
  fieldAmount: 0.25,
  terrainClass: 'hills',
  resource: 'iron',
  culture: '',
  cultureAmount: 0.6,
  cultureMode: 'keep',
  popMode: 'share',
  popTuple: null,
  popAmount: 0.4,
  popPercent: 0.5,
  popDim: '',
  popValue: '',
  territory: -1,
  newCountryShape: 'province',
  roadKind: 'minor',
  landmarkType: 'castle',
  pointType: 'marker',
  pointAttach: true,
});

export function setOptions(patch: Partial<ToolOptions>) {
  options.value = { ...options.value, ...patch };
}

// 地图的尺度（km），画笔、湖、过渡的半径范围：放在 core 里（测试拿它们对照 schema），这里沿用原来的名字
export { mapScaleKm as mapKm, brushRangeKm as brushRange, lakeRangeKm as lakeRange, reachRangeKm as reachRange };

// 新世界：大小类的选项跟着地图尺度走
export function sizesFor(w: World): Partial<ToolOptions> {
  const { width, cell } = mapScaleKm(w);
  const clampTo = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
  return {
    brushKm: roundKm(clampTo(width * 0.035, brushRangeKm(w))),
    islandKm: roundKm(defaultIslandKm(w) * 2) / 2,
    chainKm: roundKm(defaultIslandKm(w) * 2) / 2,
    lakeKm: roundKm(clampTo(Math.max(cell * 1.6, width * 0.006) * 2, lakeRangeKm(w)) * 2) / 2,
    reachKm: roundKm(clampTo(width * 0.04, reachRangeKm(w))),
  };
}
