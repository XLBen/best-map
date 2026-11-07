import { otherCultureMul, sameCultureMul } from '../grow';
import { type PatternModule, countOf, param } from '../patterns';

// 多民族帝国（第七十四轮，近现代）：面积预算最大的一两个国家（不在预留的地方里）越过文化组的边界和在本组里一样容易
// （按 reach 放宽：进别的文化组的倍数换成进同组别的文化的倍数），预算再大一些；记 Seed.multiethnic，民族主义不管它们。
// 多少：几个（小数是再多一个的可能，随机流 'multiethnic'）

export const multiethnic: PatternModule = {
  id: 'multiethnic',
  name: '多民族帝国',
  description: '一两个大国越过文化组的边界往外长，境内住着好几个文化组；民族主义不管它们',
  amountHint: '几个；小数是再多一个的可能',
  tip: '像近现代的奥匈、奥斯曼：一个大国里住着好几个民族',
  roles: { 'multiethnic': '多民族帝国' },
  params: [
    { key: 'reach', label: '越过文化组', min: 0, max: 1, step: 0.05, default: 0.85, hint: '1：进别的文化组和进同组别的文化一样容易；0：和别的国家一样' },
    { key: 'boost', label: '再大一些', min: 1, max: 4, step: 0.05, default: 2, hint: '面积预算乘这个数' },
  ],

  grow(g, use) {
    if (!(use.amount > 0)) return;
    const want = countOf(use.amount, g.stream('multiethnic')());
    const { seeds, ctx } = g;
    if (!want || seeds.length < 4) return;
    const reach = param(this, use, 'reach');
    const boost = param(this, use, 'boost');
    const order = seeds
      .map((_, o) => o)
      .filter((o) => seeds[o].region < 0)
      .sort((a, b) => seeds[b].budget - seeds[a].budget || a - b)
      .slice(0, Math.min(want, Math.floor(seeds.length / 4)));
    if (!order.length) return;
    const k = seeds.length;
    const ease = new Float64Array(k).fill(1);
    const group = new Int32Array(k);
    for (const o of order) {
      const s = seeds[o];
      s.multiethnic = true;
      s.role = 'multiethnic';
      s.budget *= boost;
      ease[o] = 1 - reach * (1 - sameCultureMul(s.gov) / otherCultureMul(s.gov));
      group[o] = ctx.cultureGroup[s.culture];
    }
    const cultureOf = ctx.cultureOf!;
    const cultureGroup = ctx.cultureGroup;
    g.stepCost.push((o, j, c) => {
      if (ease[o] === 1) return c;
      const cj = cultureOf[j];
      return cj >= 0 && cultureGroup[cj] !== group[o] ? c * ease[o] : c;
    });
  },
};
