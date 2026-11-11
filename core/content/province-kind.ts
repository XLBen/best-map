import type { z } from 'zod';
import { DEFAULT_PROVINCE_RULES, type ProvinceRules, provinceRulesSchema } from '../province-rules';
import { type FieldDesc, notBuiltin, registerKind } from './registry';
import type { ContentStore } from '../world';

// 省份划分（第七十八轮，见 province-rules.ts）：放在 small.content，命令是 set_content；一个世界只有一份。
// 只在划分省份（“省份 ⋯”的划分省份、换一种划分，重新划分一片）与陆海变了的修补时读：改了不重算，重新划分时按新的。
// 例外是“湖”：世界里的省份总是照着它整理（陆海、湖变了以后的整理按它），所以改了湖的归属马上整理一次
// （dirty 是 names：引擎在那一步之后按新的湖整理省份，记进命令，与以前的“只整理湖”同一个函数，别的省份不动）

// 大小的滑块是以前“省份大小”滑块的范围 8–200 格（格式收 4–400，以前的命令也是）
const FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'size', label: '大小', type: 'number', min: 8, max: 200, step: 1, unit: '格', hint: '一个陆地省约几格；默认 40' },
  { key: 'varied', label: '按地形调整大小', type: 'bool', hint: '平原、河谷、海岸的省小，山地、荒漠的大' },
  { key: 'wasteland', label: '无人区', type: 'bool', hint: '冰原、深漠、高山连成大片时划成无人区' },
  {
    key: 'lakeMode',
    label: '湖',
    type: 'enum',
    options: [
      { value: 'separate', label: '单独成省' },
      { value: 'merge', label: '并进旁边的陆地省' },
    ],
    hint: '海永远单独成省',
  },
  { key: 'seaByDistance', more: true, label: '近海小、远洋大', type: 'bool', hint: '海省离岸越远越大' },
  { key: 'riverCost', more: true, label: '沿河', type: 'number', min: 0, max: 20, step: 0.5, hint: '越大，省界越贴着河' },
  { key: 'ridgeCost', more: true, label: '沿山脊', type: 'number', min: 0, max: 20, step: 0.5, hint: '越大，省界越贴着山脊' },
];

const worldRules = (content: ContentStore | undefined): ProvinceRules[] => Object.values(content?.provinceRules ?? {}) as ProvinceRules[];
const lakeOf = (r: ProvinceRules | undefined) => (r ?? DEFAULT_PROVINCE_RULES).lakeMode;

// 由 kinds.ts 在画风之后调用
export function registerProvinceKind(): void {
  registerKind<ProvinceRules>({
    id: 'provinceRules',
    label: '省份划分',
    short: '省份划分',
    order: 46,
    store: 'content',
    maxInWorld: 1,
    schema: provinceRulesSchema as unknown as z.ZodType<ProvinceRules>,
    inWorld: (w) => worldRules(w.small.content),
    // 一个世界只有一份：没有时按默认的（与内置的一份相同）
    dirty: (before, after) => (lakeOf(before) !== lakeOf(after) ? 'names' : 'none'),
    blank: () => {
      const { description: _, ...rules } = DEFAULT_PROVINCE_RULES;
      return { ...rules, id: 'my-provinces', name: '新的省份划分' };
    },
    fields: FIELDS,
    pack: {
      key: 'provinceRules',
      max: 16,
      listed: true,
      checked: true,
      withId: (r, id, from) => (id === from ? r : { ...r, id, name: `${r.name} ${id.slice(from.length + 1) || id}`.slice(0, 20) }),
      fromWorld: (w) => notBuiltin('provinceRules', worldRules(w.small.content)).map((r) => structuredClone(r)),
      exportItem: (r) => structuredClone(r),
    },
  });
}
