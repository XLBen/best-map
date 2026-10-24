import type { IslandTypeInput } from '../island-types';

// 内置示例包“奇幻生态示例”的岛（第十五轮）：直接是数据，资源包、测试、脚本框的例子都用它。
//
// 湖心岛：引擎里没有“湖心岛”这回事，它只是一种自己的岛，两段脚本让它长在湖里——
//   放在哪里：只能放在湖面上（点在湖外不放；岛的范围伸出湖的部分不动）；
//   岛的样子：边上按方向起伏一点（不是正圆），中间隆起，高出湖面 4 到 30 米（每格随机再高一点）。
//     外圈 land: false：那些格不动，还是湖，所以岛四周一圈都是湖，湖面也不变。
// 这两段也是脚本框“变量和例子”里岛的例子（见 src/ui/script-examples.ts）

const script = (src: string) => ({ api: 1 as const, src });

export const LAKE_ISLE_PLACEMENT = ['// 只能放在湖面上', 'return 湖 === 1;'].join('\n');

export const LAKE_ISLE_SHAPE = [
  '// 边上按方向起伏一点，不是正圆',
  'const rim = 0.75 + 0.2 * noise(Math.cos(方位) * 1.5, Math.sin(方位) * 1.5);',
  '// 外圈不动：还是湖',
  'if (离岛心 > rim) return { land: false };',
  '// 中间隆起，高出湖面 4 到 30 米，每格再随机高一点',
  'const t = 1 - 离岛心 / rim;',
  'return 水面高度 + 4 + 26 * smoothstep(0, 1, t) + 3 * rand();',
].join('\n');

export const FANTASY_ISLAND_TYPES: IslandTypeInput[] = [
  {
    id: 'lake_isle',
    name: '湖心岛',
    shape: 'round',
    height: 'flat',
    color: '#7fa860',
    province: 'land',
    names: [{ p: '{color}{plant}洲', w: 2 }, { p: '{myth}心岛' }, { p: '{animal}渚' }],
    scripts: {
      placement: script(LAKE_ISLE_PLACEMENT),
      shape: script(LAKE_ISLE_SHAPE),
    },
  },
];
