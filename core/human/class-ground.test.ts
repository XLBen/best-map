import { describe, expect, it } from 'vitest';
import { kindOf } from '../content/registry';
import { digest } from '../digest';
import { Engine } from '../engine';
import type { Command } from '../commands';
import { BUILTIN_CLASSES } from '../packs/base';
import { resolveTerrain } from '../terrain';
import { type HumanCommand, continents, humanDigest, humanExec, seedCommands } from '../testing/fixtures';
import { classOnlyDigests, humanRegion, smallGlobe } from '../testing/class-only';
import { classCode, terrainClassSchema } from './terrain-class';
import { groundUnder } from './class-ground';
import recorded from './class-only-digests.json';

// 涂地形类别时地面跟着变（第五十八轮，见 class-ground.ts、docs/dev/history/第58轮.md）

type Eng = ReturnType<typeof continents>;
const world20 = () => continents({ cells: 12000, latNorth: 70, latSouth: 10 });

// 内陆一格为中心、半径 r 格的一笔（只有干的陆地，和界面的画笔一样），t 是到中心的距离
function disc(eng: Eng, c: number, r: number): { cells: number[]; t: number[] } {
  const { mesh, causes, derived } = eng.world;
  const cells: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    const d = Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) / (mesh.spacing * r);
    if (d < 1 && causes.land[i] && derived.lake[i] !== 1) {
      cells.push(i);
      t.push(d);
    }
  }
  return { cells, t };
}

// 离海至少 margin 格的陆格，按高度从低到高
function inland(eng: Eng, margin: number): number[] {
  const { mesh, causes, derived } = eng.world;
  const dist = new Int32Array(mesh.n).fill(-1);
  let front: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) {
      dist[i] = 0;
      front.push(i);
    }
  }
  for (let d = 1; d <= margin; d++) {
    const next: number[] = [];
    for (const i of front) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (dist[j] < 0) {
          dist[j] = d;
          next.push(j);
        }
      }
    }
    front = next;
  }
  const out: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (dist[i] < 0 && derived.lake[i] !== 1) out.push(i);
  return out.sort((a, b) => derived.elevation[a] - derived.elevation[b]);
}

const spread = (v: number[]) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};

// 原因、推导的全部数组
function arrays(eng: Eng): Record<string, string> {
  const out: Record<string, string> = {};
  const { derived, causes } = eng.world;
  for (const [k, v] of Object.entries(derived)) if (ArrayBuffer.isView(v)) out[`d.${k}`] = digest(v);
  for (const [k, v] of Object.entries(causes)) if (ArrayBuffer.isView(v)) out[`c.${k}`] = digest(v);
  return out;
}

describe('力度 0：逐位和第五十七轮相同', () => {
  // class-only-digests.json 是 f01e102（第五十七轮）的代码跑 core/testing/class-only.ts 记下的：每一步之后全部推导、原因、
  // 小数据（典型高度不算），每一步的撤销记录，再一步一步撤销回去。
  // 第七十三轮重录 region 的世界摘要（0–4、u1–u4，撤销记录不变）：小数据里的时代换了样子（国家格局）、多了国家格局这种内容；
  // 核对过把时代写回旧的 relations、去掉国家格局和它的来源时九个值与原来的逐个相同
  // 第七十四轮又重录这五个值（撤销记录照旧不变）：中世纪的国家有意改了（集权帝国、游牧汗国、民族主义），时代多了两种格局
  // 第七十五轮再重录这五个值：档案多了格局里的角色（role）；核对过不写 role 时与第七十四轮的值逐个相同
  it('一块带人文的地区：不写力度', () => expect(classOnlyDigests(humanRegion())).toEqual(recorded.region));
  it('整个星球：不写力度', () => expect(classOnlyDigests(smallGlobe())).toEqual(recorded.globe));
  it('写 strength: 0 和不写相同', () => expect(classOnlyDigests(smallGlobe(), { strength: 0 })).toEqual(recorded.globe));
  it('写了 t 也一样（力度 0 不看）', () => {
    const eng = smallGlobe();
    const land = [...eng.world.causes.land.keys()].filter((i) => eng.world.causes.land[i]).slice(0, 50);
    const a = eng.clone();
    a.exec({ op: 'set_cell_class', cells: land, class: 'hills' });
    eng.exec({ op: 'set_cell_class', cells: land, class: 'hills', strength: 0, t: land.map(() => 0.5) });
    expect(arrays(eng)).toEqual(arrays(a));
  });
  it('没写典型高度的类别：力度大于 0 也只改类别', () => {
    const eng = world20();
    const item = { id: 'moor', name: '荒原', color: '#888888', priority: 0, rules: [] };
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'moor', item } as Command);
    const land = inland(eng, 4).slice(0, 40);
    const before = eng.world.causes.upliftDelta.slice();
    const a = eng.clone();
    a.exec({ op: 'set_cell_class', cells: land, class: 'moor' });
    eng.exec({ op: 'set_cell_class', cells: land, class: 'moor', strength: 0.8, t: land.map(() => 0) });
    expect(arrays(eng)).toEqual(arrays(a));
    expect(eng.world.causes.upliftDelta).toEqual(before);
    const code = classCode(eng.world.small, 'moor');
    expect(land.every((i) => eng.world.derived.terrainClass[i] === code)).toBe(true);
  });
});

describe('地面升向典型高度', () => {
  const mean = (eng: Eng, s: { cells: number[]; t: number[] }) => groundUnder(s.cells, s.t, eng.world.derived.elevation);

  it('山地：一笔不跳到头，越涂越接近，不越过；保留起伏，不是平顶；类别不被改回去', () => {
    const eng = world20();
    const low = inland(eng, 8);
    const s = disc(eng, low[Math.floor(low.length * 0.2)], 8);
    const code = classCode(eng.world.small, 'mountains');
    const start = mean(eng, s);
    expect(start).toBeLessThan(800);
    const seen = [start];
    for (let k = 0; k < 6; k++) {
      eng.exec({ op: 'set_cell_class', ...s, class: 'mountains', strength: 0.5 });
      seen.push(mean(eng, s));
      // 自动分类改不回去（抬升之后这里新积的湖是水面，没有类别）
      const d = eng.world.derived;
      expect(s.cells.every((i) => d.lake[i] === 1 || d.terrainClass[i] === code)).toBe(true);
      expect(s.cells.every((i) => eng.world.causes.terrainClass![i] === code)).toBe(true);
    }
    // 第一笔看得出（至少两百米），但只走了一部分
    expect(seen[1] - seen[0]).toBeGreaterThan(200);
    expect(seen[1]).toBeLessThan(1800);
    for (let k = 1; k < seen.length; k++) expect(seen[k]).toBeGreaterThan(seen[k - 1]);
    // 步子越来越小：最后一笔比第一笔走得少
    expect(seen[6] - seen[5]).toBeLessThan(seen[1] - seen[0]);
    expect(seen[6]).toBeLessThan(2400 * 1.15);
    expect(seen[6]).toBeGreaterThan(1200);
    // 不是平顶：山脊比山谷高得多
    const core = s.cells.filter((_, k) => s.t[k] < 0.6).map((i) => eng.world.derived.elevation[i]);
    expect(spread(core)).toBeGreaterThan(200);
  });

  it('力度 1 也不越过（几种画笔大小）', () => {
    for (const r of [3, 6, 12]) {
      const eng = world20();
      const low = inland(eng, Math.min(r, 8));
      const s = disc(eng, low[Math.floor(low.length * 0.3)], r);
      let last = 0;
      for (let k = 0; k < 4; k++) {
        eng.exec({ op: 'set_cell_class', ...s, class: 'hills', strength: 1 });
        last = mean(eng, s);
      }
      expect(last).toBeLessThan(600 * 1.25);
    }
  });

  it('平原：山上压低、真的变平', () => {
    const eng = world20();
    const high = inland(eng, 6);
    // 高度靠抬升撑着的地方（高得多的格里抬升最大的一格）：基准面撑着的高原压不下去，见第58轮.md
    const up = eng.world.causes.uplift;
    const c = high.slice(-Math.floor(high.length * 0.1)).sort((a, b) => up[b] - up[a])[0];
    const s = disc(eng, c, 6);
    const core = () => s.cells.filter((_, k) => s.t[k] < 0.6).map((i) => eng.world.derived.elevation[i]);
    const start = mean(eng, s);
    const sd0 = spread(core());
    const top0 = Math.max(...core());
    for (let k = 0; k < 6; k++) eng.exec({ op: 'set_cell_class', ...s, class: 'plains', strength: 0.5 });
    expect(mean(eng, s)).toBeLessThan(start * 0.75);
    expect(spread(core())).toBeLessThan(sd0 * 0.75);
    expect(Math.max(...core())).toBeLessThan(top0 * 0.75);
  });

  it('笔刷边缘是软的：边上的抬升变化比中心小得多，到边上接近 0', () => {
    const eng = world20();
    const low = inland(eng, 8);
    const s = disc(eng, low[Math.floor(low.length * 0.2)], 8);
    const before = eng.world.causes.upliftDelta.slice();
    eng.exec({ op: 'set_cell_class', ...s, class: 'mountains', strength: 0.5 });
    const d = (lo: number, hi: number) => {
      const v = s.cells.filter((_, k) => s.t[k] >= lo && s.t[k] < hi).map((i) => eng.world.causes.upliftDelta[i] - before[i]);
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    expect(d(0, 0.2)).toBeGreaterThan(0.05);
    expect(d(0.9, 1)).toBeLessThan(d(0, 0.2) * 0.1);
  });

  it('“最高的山”调低也不越过（典型高度是绝对的米）', () => {
    const eng = world20();
    eng.exec({ op: 'set_planet', patch: { mountainScale: 3000 } });
    const low = inland(eng, 8);
    const s = disc(eng, low[Math.floor(low.length * 0.2)], 8);
    for (let k = 0; k < 4; k++) eng.exec({ op: 'set_cell_class', ...s, class: 'hills', strength: 0.5 });
    expect(mean(eng, s)).toBeLessThan(600 * 1.25);
  });
});

describe('陆海不变', () => {
  it('涂在海岸、海上：海岸线、陆地、海上的类别和抬升一个都不变', () => {
    const eng = world20();
    const { mesh, causes } = eng.world;
    // 一个挨海的格为中心的一大笔，海格也在命令里
    const shore = [...causes.land.keys()].find((i) => {
      if (!causes.land[i]) return false;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) return true;
      return false;
    })!;
    const cells: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      const d = Math.hypot(mesh.x[i] - mesh.x[shore], mesh.y[i] - mesh.y[shore]) / (mesh.spacing * 10);
      if (d < 1) {
        cells.push(i);
        t.push(d);
      }
    }
    expect(cells.some((i) => !causes.land[i])).toBe(true);
    const keep = () => digest([causes.land, causes.landness, causes.landDelta, causes.islandType, causes.erodDelta, causes.erod]);
    const before = keep();
    const lift0 = causes.upliftDelta.slice();
    for (const c of ['plains', 'mountains', 'plains', 'peaks']) {
      eng.exec({ op: 'set_cell_class', cells, t, class: c, strength: 1 });
      expect(keep()).toBe(before);
      expect(cells.filter((i) => !causes.land[i]).every((i) => !causes.terrainClass![i] && causes.upliftDelta[i] === lift0[i])).toBe(true);
      // 陆地还是高于海面
      for (const i of cells) if (causes.land[i]) expect(eng.world.derived.elevation[i]).toBeGreaterThan(0);
    }
  });

  it('湖面上的格不涂：不改类别、不改抬升，记进命令的格里也没有', () => {
    const eng = world20();
    const { mesh, derived, causes } = eng.world;
    const lake = [...derived.lake.keys()].find((i) => derived.lake[i] === 1 && causes.land[i]);
    expect(lake).toBeDefined();
    const cells: number[] = [];
    for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - mesh.x[lake!], mesh.y[i] - mesh.y[lake!]) < mesh.spacing * 5) cells.push(i);
    const wet = cells.filter((i) => derived.lake[i] === 1);
    const lift0 = causes.upliftDelta.slice();
    eng.exec({ op: 'set_cell_class', cells, t: cells.map(() => 0.2), class: 'hills', strength: 0.5 });
    expect(wet.every((i) => !causes.terrainClass?.[i] && causes.upliftDelta[i] === lift0[i])).toBe(true);
    const cmd = eng.toDoc().commands.at(-1) as Extract<Command, { op: 'set_cell_class' }>;
    expect(wet.some((i) => cmd.cells.includes(i))).toBe(false);
    expect(cmd.t!.length).toBe(cmd.cells.length);
  });

  it('只改涂到的格时每格的抬升和整个重新组合相同', () => {
    const eng = world20();
    const low = inland(eng, 8);
    const s = disc(eng, low[Math.floor(low.length * 0.5)], 8);
    // 先堆到头、压到底，留下余量
    eng.exec({ op: 'paint_relief', ...s, strength: 2 });
    eng.exec({ op: 'paint_relief', ...s, strength: 2 });
    eng.exec({ op: 'set_cell_class', ...s, class: 'plains', strength: 0.5 });
    const after = digest([eng.world.causes.uplift, eng.world.causes.land]);
    resolveTerrain(eng.world);
    expect(digest([eng.world.causes.uplift, eng.world.causes.land])).toBe(after);
  });
});

describe('撤销、重做、重放', () => {
  const paint = (eng: Eng): Command[] => {
    const low = inland(eng, 8);
    const a = disc(eng, low[Math.floor(low.length * 0.2)], 7);
    const b = disc(eng, low[Math.floor(low.length * 0.9)], 7);
    return [
      { op: 'set_cell_class', ...a, class: 'mountains', strength: 0.5 },
      { op: 'set_cell_class', ...b, class: 'plains', strength: 0.5 },
      { op: 'set_cell_class', ...a, class: 'peaks', strength: 1 },
      { op: 'set_cell_class', cells: a.cells.slice(0, 30), class: 'hills', strength: 0.3 },
    ];
  };

  it('撤销回到原样、重做一字不差，一步一步都是', () => {
    const eng = world20();
    const start = arrays(eng);
    const states: Record<string, string>[] = [];
    for (const c of paint(eng)) {
      eng.exec(c);
      states.push(arrays(eng));
    }
    expect(states[0]['c.upliftDelta']).not.toBe(start['c.upliftDelta']);
    expect(states[0]['d.elevation']).not.toBe(start['d.elevation']);
    for (let k = states.length - 1; k >= 0; k--) {
      expect(arrays(eng)).toEqual(states[k]);
      eng.undo();
    }
    expect(arrays(eng)).toEqual(start);
    for (const s of states) {
      eng.redo();
      expect(arrays(eng)).toEqual(s);
    }
  });

  it('存档重放逐值相同（记下的平均高度照用，不用先算推导）', () => {
    const eng = world20();
    const list = paint(eng);
    for (const c of list) eng.exec(c);
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    const cmds = doc.commands.filter((c: Command) => c.op === 'set_cell_class') as Extract<Command, { op: 'set_cell_class' }>[];
    expect(cmds.length).toBe(list.length);
    for (const c of cmds) expect(typeof c.ground).toBe('number');
    const replayed = Engine.fromDoc(doc, eng.world.mesh);
    expect(arrays(replayed)).toEqual(arrays(eng));
    // 重放的结果和没记平均高度的命令一样：第一次执行记下的就是当时读到的
    const again = world20();
    for (const c of cmds) {
      const { ground: _, ...raw } = c;
      again.exec(raw);
    }
    expect(arrays(again)).toEqual(arrays(eng));
  });

  it('批量里的一笔：重放相同（读到的都是这个批量之前的推导）', () => {
    const eng = world20();
    const list = paint(eng);
    eng.exec({ op: 'batch', commands: list.slice(0, 2) });
    const replayed = Engine.fromDoc(JSON.parse(JSON.stringify(eng.toDoc())), eng.world.mesh);
    expect(arrays(replayed)).toEqual(arrays(eng));
  });
});

describe('恢复自动', () => {
  it('力度大于 0：中心回到生成时的地面；只动画过类别的格，别处堆的山还在；陆海不变', () => {
    const eng = world20();
    const low = inland(eng, 10);
    const a = disc(eng, low[Math.floor(low.length * 0.2)], 6);
    const hill = disc(eng, low[Math.floor(low.length * 0.8)], 6);
    eng.exec({ op: 'paint_relief', ...hill, strength: 0.7 });
    const piled = eng.world.causes.upliftDelta.slice();
    const elev0 = eng.world.derived.elevation.slice();
    eng.exec({ op: 'set_cell_class', ...a, class: 'mountains', strength: 0.5 });
    expect(digest(eng.world.derived.elevation)).not.toBe(digest(elev0));
    // 整片都在 t = 0：像橡皮的中心
    eng.exec({ op: 'set_cell_class', cells: [...a.cells, ...hill.cells], t: [...a.cells, ...hill.cells].map(() => 0), class: null, strength: 0.5 });
    expect(digest(eng.world.causes.upliftDelta)).toBe(digest(piled));
    expect(digest(eng.world.derived.elevation)).toBe(digest(elev0));
    expect(a.cells.every((i) => !eng.world.causes.terrainClass![i])).toBe(true);
  });

  it('软边：边上留一部分，和堆山的橡皮同一条线', () => {
    const eng = world20();
    const low = inland(eng, 10);
    const a = disc(eng, low[Math.floor(low.length * 0.2)], 6);
    eng.exec({ op: 'set_cell_class', ...a, class: 'mountains', strength: 0.5 });
    const i = a.cells[0];
    const old = eng.world.causes.upliftDelta[i];
    expect(old).not.toBe(0);
    eng.exec({ op: 'set_cell_class', cells: [i], t: [0.85], class: null, strength: 0.5 });
    expect(eng.world.causes.upliftDelta[i]).toBeCloseTo(old * 0.5, 3);
  });

  it('力度 0：只去掉类别，地面不动', () => {
    const eng = world20();
    const low = inland(eng, 10);
    const a = disc(eng, low[Math.floor(low.length * 0.2)], 6);
    eng.exec({ op: 'set_cell_class', ...a, class: 'mountains', strength: 0.5 });
    const lift = digest(eng.world.causes.upliftDelta);
    eng.exec({ op: 'set_cell_class', cells: a.cells, class: null });
    expect(digest(eng.world.causes.upliftDelta)).toBe(lift);
    expect(a.cells.every((i) => !eng.world.causes.terrainClass![i])).toBe(true);
  });

  it('堆山的橡皮只擦高度，类别还在', () => {
    const eng = world20();
    const low = inland(eng, 10);
    const a = disc(eng, low[Math.floor(low.length * 0.2)], 6);
    eng.exec({ op: 'set_cell_class', ...a, class: 'mountains', strength: 0.5 });
    eng.exec({ op: 'restore_terrain', cells: a.cells, t: a.cells.map(() => 0) });
    expect(a.cells.every((i) => eng.world.causes.upliftDelta[i] === 0 && eng.world.causes.terrainClass![i] > 0)).toBe(true);
  });
});

describe('内容', () => {
  it('内置的类别都写了典型高度，从低到高；能进字段表，超范围不接受', () => {
    expect(BUILTIN_CLASSES.map((c) => [c.id, c.height])).toEqual([
      ['plains', 150],
      ['hills', 600],
      ['highlands', 1400],
      ['mountains', 2400],
      ['peaks', 3800],
    ]);
    expect(kindOf('terrainClass')!.fields!.some((f) => f.key === 'height' && f.type === 'number' && f.optional)).toBe(true);
    expect(terrainClassSchema.safeParse({ ...BUILTIN_CLASSES[0], height: 10000 }).success).toBe(false);
    const { height: _, ...noHeight } = BUILTIN_CLASSES[0];
    expect(terrainClassSchema.safeParse(noHeight).success).toBe(true);
  });

  it('生成不读典型高度：去掉它，人文、类别的摘要全都相同', () => {
    const strip = (cmds: readonly Command[]): Command[] =>
      cmds.map((c) => {
        if (c.op === 'batch') return { ...c, commands: strip(c.commands) };
        if (c.op === 'set_content' && c.kind === 'terrainClass' && c.item) {
          const { height: _, ...item } = c.item as Record<string, unknown>;
          return { ...c, item } as Command;
        }
        return c;
      });
    const build = (content: readonly Command[]) => {
      const settings = { seed: 2, cells: 5000, latNorth: 60, latSouth: 20 };
      const eng = new Engine(settings);
      for (const c of content) eng.exec(c);
      eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
      humanExec(eng, { op: 'generate_human', era: 'medieval', groups: [{ id: 'british', weight: 1 }] } as HumanCommand);
      return eng;
    };
    const a = build(seedCommands());
    const b = build(strip(seedCommands()));
    expect(humanDigest(a.world)).toEqual(humanDigest(b.world));
    expect(arrays(a)).toEqual(arrays(b));
  });

  it('重新生成人文：画过的类别和地面都不动，人文按它们算', () => {
    const eng = humanRegion();
    const low = inland(eng, 4);
    const a = disc(eng, low[Math.floor(low.length * 0.3)], 4);
    eng.exec({ op: 'set_cell_class', ...a, class: 'mountains', strength: 0.5 });
    const keep = digest([eng.world.causes.upliftDelta, eng.world.causes.terrainClass!, eng.world.derived.elevation]);
    const code = classCode(eng.world.small, 'mountains');
    eng.exec({ op: 'regenerate_human', seed: 99 } as Command);
    expect(digest([eng.world.causes.upliftDelta, eng.world.causes.terrainClass!, eng.world.derived.elevation])).toBe(keep);
    expect(a.cells.every((i) => eng.world.derived.terrainClass[i] === code)).toBe(true);
  });

  it('移出一种类别：画成它的格恢复自动，地面留着', () => {
    const eng = world20();
    const low = inland(eng, 10);
    const a = disc(eng, low[Math.floor(low.length * 0.2)], 6);
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'moor', item: { id: 'moor', name: '荒原', color: '#888888', priority: 0, rules: [], height: 1000 } } as Command);
    eng.exec({ op: 'set_cell_class', ...a, class: 'moor', strength: 0.5 });
    const lift = digest(eng.world.causes.upliftDelta);
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'moor', item: null } as Command);
    expect(digest(eng.world.causes.upliftDelta)).toBe(lift);
    expect(a.cells.every((i) => !eng.world.causes.terrainClass![i])).toBe(true);
  });
});
