import { SUBJECT_KINDS, type SubjectKind } from '../../era';
import { vassalOf } from '../../tiers';
import { pickWeighted } from '../base';
import { type PatternModule, param } from '../patterns';

// 附庸（第二十六轮，在外交里；第七十三轮挪成格局）：从小到大看，旁边大三倍以上的国家按它的政体的“收附庸”收下；最多两层
// （附庸也可以有自己的附庸）。预留地方里的国家（神圣帝国的诸侯）不当别国的附庸。从属的种类按参数的比例挑（都是 0 时不写，算附庸）。
// 多少：乘在收下的可能上（1 是政体写的那么多，0 没有附庸）。时代没列附庸的格局时照样有附庸（fallback 1），都算附庸。
// 代码从 countries.ts 的 diplomacy 原样搬来，随机流的名字不变：'vassal'

// 殖民地（第七十四轮）是殖民地的格局写的，附庸不挑它
const SUBJECT_LIST = SUBJECT_KINDS.filter((k): k is Exclude<SubjectKind, 'colony'> => k !== 'colony');
const LABEL: Record<(typeof SUBJECT_LIST)[number], string> = { vassal: '附庸', protectorate: '保护国', dominion: '自治领', tributary: '朝贡国' };

export const vassals: PatternModule = {
  id: 'vassals',
  name: '附庸',
  description: '小国当旁边大三倍以上的国家的附庸（最多两层）；从属的种类按比例挑',
  amountHint: '乘在收附庸的可能上；1 是政体写的那么多，0 没有附庸',
  fallback: 1,
  params: SUBJECT_LIST.map((k) => ({ key: k, label: LABEL[k], min: 0, max: 100, step: 0.1, default: 0, hint: `从属里${LABEL[k]}占多少；都是 0 时都算附庸` })),

  diplomacy(g, use) {
    const { seeds, ctx } = g;
    const metas = g.metas!;
    const areaOf = g.areaOf!;
    const neighbors = g.neighbors!;
    const overlord = g.overlord!;
    const k = seeds.length;
    const group = (o: number) => ctx.cultureGroup[seeds[o].culture];
    // 下面有几层附庸
    const below = new Int32Array(k);
    const above = (o: number) => {
      let dd = 0;
      for (let a = overlord[o]; a >= 0; a = overlord[a]) dd++;
      return dd;
    };
    const weight = (s: (typeof SUBJECT_LIST)[number]) => param(this, use, s);
    const kinds = SUBJECT_LIST.filter((s) => weight(s) > 0);
    const order = seeds.map((_, o) => o).sort((a, b) => areaOf[a] - areaOf[b] || a - b);
    for (const v of order) {
      if (below[v] >= 2 || seeds[v].region >= 0) continue;
      let best = -1;
      for (const u of neighbors[v]) {
        if (areaOf[u] < 3 * areaOf[v] || below[v] + 1 + above(u) > 2) continue;
        if (best < 0 || areaOf[u] > areaOf[best] || (areaOf[u] === areaOf[best] && u < best)) best = u;
      }
      if (best < 0) continue;
      const rr = g.stream('vassal', v);
      const p = seeds[best].gov.vassals * (group(best) === group(v) ? 1 : 0.5) * vassalOf(seeds[v].tier) * (below[v] > 0 || above(best) > 0 ? 0.5 : 1) * use.amount;
      if (rr() >= p) continue;
      overlord[v] = best;
      for (let a = best, dd = below[v] + 1; a >= 0; a = overlord[a], dd++) below[a] = Math.max(below[a], dd);
      metas[v].overlord = metas[best].id;
      if (kinds.length) metas[v].subject = pickWeighted(kinds, weight, rr)!;
    }
  },
};
