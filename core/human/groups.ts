import type { Causes, PopTuple, SmallState } from '../world';

// 人口群体（第二十二轮）：群体 = 文化 + 时代每一维的取值。世界里每个出现过的群体一个编号（small.popGroups，1 起），
// 每格记人数最多的 4 个群体的编号与占比（causes.popGroup / popShare，n × 4，占比 /255），剩下的是“其他”。

export const SLOTS = 4;

// 一格的成分：群体的编号与占比（0–1）。编号 0 是“其他”（认不出是哪个群体的那些人）
export interface Share {
  code: number;
  s: number;
}

export const tupleKey = (t: PopTuple): string =>
  `${t.culture}|${Object.keys(t.values)
    .sort()
    .map((k) => `${k}=${t.values[k]}`)
    .join(',')}`;

// 群体的编号表：读世界里的、给新的群体编号。改完 commit() 写回世界（换一个新的对象：按对象缓存的表跟着失效）
export class GroupTable {
  private groups: Record<string, PopTuple>;
  private byKey = new Map<string, number>();
  private next: number;
  private dirty = false;
  constructor(private small: Pick<SmallState, 'popGroups' | 'human'>) {
    this.groups = { ...(small.popGroups ?? {}) };
    let max = 0;
    for (const [k, t] of Object.entries(this.groups)) {
      const code = Number(k);
      this.byKey.set(tupleKey(t), code);
      if (code > max) max = code;
    }
    this.next = Math.max(small.human?.nextGroup ?? 1, max + 1);
  }
  get(code: number): PopTuple | undefined {
    return this.groups[code];
  }
  // 群体的编号（没有时新给一个）
  code(t: PopTuple): number {
    const key = tupleKey(t);
    let c = this.byKey.get(key);
    if (c === undefined) {
      if (this.next > 65535) throw new Error('人口群体太多（最多 65535 种）');
      c = this.next++;
      this.groups[c] = { culture: t.culture, values: { ...t.values } };
      this.byKey.set(key, c);
      this.dirty = true;
    }
    return c;
  }
  // 已有的群体的编号（没有时不新给）
  find(t: PopTuple): number | undefined {
    return this.byKey.get(tupleKey(t));
  }
  commit() {
    if (!this.dirty) return;
    this.small.popGroups = this.groups;
    if (this.small.human) this.small.human.nextGroup = this.next;
    this.dirty = false;
  }
}

type PopCauses = Pick<Causes, 'popTotal' | 'popGroup' | 'popShare'>;

// 第 i 格的成分（按占比从大到小；“其他”在最后，没有时不列）
export function readComp(c: PopCauses, i: number): Share[] {
  const out: Share[] = [];
  const g = c.popGroup;
  const s = c.popShare;
  if (!g || !s) return out;
  let sum = 0;
  for (let k = 0; k < SLOTS; k++) {
    const code = g[i * SLOTS + k];
    if (!code) continue;
    const v = s[i * SLOTS + k];
    sum += v;
    out.push({ code, s: v / 255 });
  }
  if (sum < 255 && out.length) out.push({ code: 0, s: (255 - sum) / 255 });
  return out;
}

// 同一个编号的并在一起，按占比从大到小（一样大时编号小的在前）
export function mergeComp(list: readonly Share[]): Share[] {
  const m = new Map<number, number>();
  for (const x of list) if (x.s > 0) m.set(x.code, (m.get(x.code) ?? 0) + x.s);
  return [...m].map(([code, s]) => ({ code, s })).sort((a, b) => b.s - a.s || a.code - b.code);
}

// 写回第 i 格：占比先按总和归一，取最多的 4 个（“其他”不占位），四舍五入成 /255，4 个加起来不超过 255
export function writeComp(c: PopCauses, i: number, comp: readonly Share[]) {
  const g = c.popGroup!;
  const s = c.popShare!;
  const merged = mergeComp(comp);
  let total = 0;
  for (const x of merged) total += x.s;
  const top = merged.filter((x) => x.code !== 0).slice(0, SLOTS);
  const q = top.map((x) => (total > 0 ? Math.round((x.s / total) * 255) : 0));
  let sum = q.reduce((a, b) => a + b, 0);
  // 四舍五入多出来的从小的那个里扣
  for (let k = q.length - 1; sum > 255 && k >= 0; k--) {
    const cut = Math.min(q[k], sum - 255);
    q[k] -= cut;
    sum -= cut;
  }
  for (let k = 0; k < SLOTS; k++) {
    const ok = k < top.length && q[k] > 0;
    g[i * SLOTS + k] = ok ? top[k].code : 0;
    s[i * SLOTS + k] = ok ? q[k] : 0;
  }
  // 编号 0 的空位挪到后面（扣成 0 的那几个）
  for (let k = 0; k < SLOTS - 1; k++) {
    if (g[i * SLOTS + k]) continue;
    for (let j = k + 1; j < SLOTS; j++) {
      if (!g[i * SLOTS + j]) continue;
      g[i * SLOTS + k] = g[i * SLOTS + j];
      s[i * SLOTS + k] = s[i * SLOTS + j];
      g[i * SLOTS + j] = 0;
      s[i * SLOTS + j] = 0;
      break;
    }
  }
}

// 清空第 i 格
export function clearCell(c: PopCauses, i: number) {
  c.popTotal![i] = 0;
  for (let k = 0; k < SLOTS; k++) {
    c.popGroup![i * SLOTS + k] = 0;
    c.popShare![i * SLOTS + k] = 0;
  }
}

// 用到的群体按第一次出现的格重新编号（1 起），去掉没用到的：生成之后整理一遍。
// extra（第二十七轮）：别的也记着群体编号的数组（自动的结果的快照，见 auto.ts），排在 popGroup 之后一起重新编号
export function compactGroups(small: Pick<SmallState, 'popGroups' | 'human'>, c: PopCauses, extra: readonly Uint16Array[] = []) {
  const old = small.popGroups ?? {};
  const map = new Map<number, number>();
  const out: Record<string, PopTuple> = {};
  for (const g of [c.popGroup!, ...extra]) {
    for (let k = 0; k < g.length; k++) {
      const v = g[k];
      if (!v) continue;
      let nv = map.get(v);
      if (nv === undefined) {
        nv = map.size + 1;
        map.set(v, nv);
        out[nv] = old[v];
      }
      g[k] = nv;
    }
  }
  small.popGroups = out;
  if (small.human) small.human.nextGroup = map.size + 1;
}
