import { type PatternModule, param } from '../patterns';

// 民族主义（第七十四轮）：时代的 nationalism（0–1，民族主义的时代以后强，以前弱）让国家不愿越过文化的边界。
// 往外长时进别的文化的格，代价再 ×（1 + k · nationalism）：同一个文化组里 k 小（sameGroup），别的文化组 k 大（otherGroup）。
// 不是每个国家都在乎：每国按 care 的可能各自定（随机流 'nationalism'，按第几国）；预留的地方里的（诸侯、城邦、殖民地）、
// 多民族的大国（multiethnic）不在乎。时代没列它也照样用（fallback 1）：多少乘在时代的 nationalism 上，时代没写 nationalism 时什么都不做

export const nationalism: PatternModule = {
  id: 'nationalism',
  name: '民族主义',
  description: '国家不愿越过文化的边界往外长（按时代的“民族主义”有多强）；不是每个国家都在乎',
  amountHint: '乘在时代的“民族主义”上；1 照时代写的，0 没有',
  tip: '时代没列也起作用；强弱看时代的“文化的倒向”，这里调谁在乎、在乎多少',
  fallback: 1,
  params: [
    { key: 'sameGroup', label: '同组文化的阻力', min: 0, max: 10, step: 0.1, default: 0.8, hint: '进同组别的文化的代价' },
    { key: 'otherGroup', label: '别组文化的阻力', min: 0, max: 20, step: 0.1, default: 3, hint: '进别的文化组的代价' },
    { key: 'care', label: '在乎的几成', min: 0, max: 1, step: 0.05, default: 0.7, hint: '每个国家在乎民族的可能' },
  ],

  grow(g, use) {
    const N = (g.ctx.era.nationalism ?? 0) * use.amount;
    if (!(N > 0)) return;
    const { seeds, ctx } = g;
    const cultureOf = ctx.cultureOf!;
    const cultureGroup = ctx.cultureGroup;
    const kSame = 1 + param(this, use, 'sameGroup') * N;
    const kOther = 1 + param(this, use, 'otherGroup') * N;
    const care = param(this, use, 'care');
    const k = seeds.length;
    const prim = new Int32Array(k);
    const group = new Int32Array(k);
    const on = new Uint8Array(k);
    let any = false;
    seeds.forEach((s, o) => {
      prim[o] = s.culture;
      group[o] = cultureGroup[s.culture];
      // 每国一个数（不管在不在乎都取，先后不随别的国家变）
      const r = g.stream('nationalism', o)();
      if (s.region >= 0 || s.multiethnic || !(r < care)) return;
      on[o] = 1;
      any = true;
    });
    if (!any || (kSame === 1 && kOther === 1)) return;
    g.stepCost.push((o, j, c) => {
      if (!on[o]) return c;
      const cj = cultureOf[j];
      if (cj < 0 || cj === prim[o]) return c;
      return c * (cultureGroup[cj] === group[o] ? kSame : kOther);
    });
  },
};
