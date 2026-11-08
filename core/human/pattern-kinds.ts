import type { z } from 'zod';
import { type FieldDesc, notBuiltin, registerKind } from '../content/registry';
import { CommandError } from '../errors';
import { type CountryPattern, patternModule, patternModules, worldPatterns } from './countries/patterns';
import { AMOUNT_MAX, countryPatternSchema } from './countries/patterns/index';

// 第七十三轮的国家格局（countryPattern）登记进登记表：放在 small.content，命令是 set_content。
// 只在生成国家时读（时代的 patterns 指着它）：改了不重算（dirty 是 none），重新生成国家时按新的。
// 内置的在每个库的“时代”小包里，和用它的时代放在一起

const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);

// 每个模块的参数只在选着它时显示（键平铺在项里；换模块时别的模块的参数去掉）
function patternFields(): FieldDesc[] {
  const mods = patternModules();
  return [
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'description', label: '说明', type: 'longtext', optional: true },
    { key: 'module', label: '模块', type: 'enum', options: mods.map((m) => ({ value: m.id, label: m.name })), hint: '这一种格局怎么生成' },
    // 第七十五轮：每个模块“多少”是什么意思写在页面上模块的提示里（patternTip），这里只写一句
    { key: 'amount', label: '多少', type: 'number', min: 0, max: AMOUNT_MAX, step: 0.1, hint: '时代里没写时用它' },
    ...mods.flatMap((m) => (m.params ?? []).map((p): FieldDesc => ({ key: p.key, label: p.label, type: 'number', optional: true, min: p.min, max: p.max, step: p.step, ...(p.hint ? { hint: p.hint } : {}), when: { key: 'module', is: m.id } }))),
  ];
}

const unknownModule = (p: Pick<CountryPattern, 'name' | 'module'>) => `国家格局“${p.name}”的模块 ${p.module} 不认识`;

// 由 human/kinds.ts 在国家等级、格局之后调用
export function registerPatternKinds(): void {
  registerKind<CountryPattern>({
    id: 'countryPattern',
    label: '国家格局',
    short: '国家格局',
    order: 44.5,
    store: 'content',
    maxInWorld: 64,
    schema: countryPatternSchema as unknown as z.ZodType<CountryPattern>,
    inWorld: (w) => worldPatterns(w.small),
    dirty: () => 'none',
    check: (p) => {
      if (!patternModule(p.module)) throw new CommandError(unknownModule(p));
    },
    blank: () => ({ id: 'my-pattern', name: '新格局', module: 'alliance', amount: 1 }),
    fields: patternFields(),
    pack: {
      key: 'countryPatterns',
      max: 64,
      listed: true,
      checked: true,
      withId: (p, id, from) => (id === from ? p : { ...p, id, name: renamed(p.name, id, from) }),
      fromWorld: (w) => notBuiltin('countryPattern', worldPatterns(w.small)).map((p) => structuredClone(p)),
      exportItem: (p) => structuredClone(p),
      problems: (items) => items.flatMap((p) => (patternModule(p.module) ? [] : [`${unknownModule(p)}：用到世界时不能加`])),
    },
  });
}
