import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coastalStroke, digest, digestWorld } from '../tools/hash';
import { Engine } from './engine';
import { type Reroll, type WorldType, rerollSchema, worldgenSchema } from './generate';
import type { SphereMesh } from './mesh';
import { POLAR_CONTINENTS, RING_SEA, FANTASY_FORMS, TWIN_CONTINENTS } from './packs/fantasy-forms';
import { type PlanetForm, planetFormSchema } from './planet-form';
import { ScriptError, scriptStats, scriptVariablesFor, setScriptsEnabled } from './script';
import { buildSphereMesh, nearestCell } from './sphere';
import { ensureBase, planetFormIssues, resolveTerrain } from './terrain';
import { engineFor, meshFor } from './testing/fixtures';
import { type World, createWorld } from './world';

// 星球形态（第八轮第三批 W8 的核心部分）：声明式的配方与倍数、布局脚本、地形脚本、软失败、缓存键、
// 安全模式、重放与撤销。星球都很小（不超过 8000 格）

const globe = (cells: number) => ({ cells, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
const meshes = new Map<number, SphereMesh>();
const meshOf = (cells: number) => {
  let m = meshes.get(cells);
  if (!m) meshes.set(cells, (m = buildSphereMesh(cells, 1)));
  return m;
};

// 只算地形（不跑气候、水文）：生成器与海陆
function planet(cells: number, seed: number, type: WorldType, form?: PlanetForm, extra: { islands?: number } = {}, rerolls: Reroll[] = []): World {
  const w = createWorld(globe(cells), meshOf(cells));
  w.small.terrain.gen = { seed, type, mountains: 1, rerolls, ...extra, ...(form ? { form } : {}) };
  resolveTerrain(w);
  return w;
}

const terrainDigest = (w: World) => ({
  landness: digest(w.causes.landness),
  uplift: digest(w.causes.uplift),
  erod: digest(w.causes.erod),
  land: digest(w.causes.land),
});

// 陆地的连通块（面积，从大到小）与陆地比例
function landParts(w: World): { frac: number; parts: number[] } {
  const { mesh, causes } = w;
  const n = mesh.n;
  const seen = new Uint8Array(n);
  const parts: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) total += mesh.area[i];
  for (let s = 0; s < n; s++) {
    if (!causes.land[s] || seen[s]) continue;
    seen[s] = 1;
    const q = [s];
    let area = 0;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      area += mesh.area[i];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (causes.land[j] && !seen[j]) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    parts.push(area);
  }
  const land = parts.reduce((a, b) => a + b, 0);
  return { frac: land / total, parts: parts.sort((a, b) => b - a).map((a) => a / land) };
}

// 斐波那契点阵：均匀铺满球面的采样点（显示坐标）
function samples(count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const z = 1 - (2 * k + 1) / count;
    const lon = (k * Math.PI * (3 - Math.sqrt(5))) % (2 * Math.PI);
    out.push([lon / Math.PI, Math.acos(z) / Math.PI]);
  }
  return out;
}

const withScripts = (form: PlanetForm, scripts: PlanetForm['scripts'], more: Partial<PlanetForm> = {}): PlanetForm => ({ ...form, ...more, scripts });
const noScripts = (form: PlanetForm): PlanetForm => {
  const { scripts: _, ...rest } = form;
  return rest;
};
const src = (s: string) => ({ api: 1 as const, src: s });

describe('星球形态的格式', () => {
  // 加星球形态之前的 worldgenSchema（照抄）
  const oldSchema = z.object({
    seed: z.number().int().min(0).max(0xffffffff).default(1),
    type: z.enum(['archipelago', 'continent', 'continents', 'fragmented', 'inland_sea', 'ocean']).default('continents'),
    landFraction: z.number().min(0).max(0.85).optional(),
    islands: z.number().min(0).max(1).optional(),
    mountains: z.number().min(0).max(2).default(1),
    rerolls: z.array(rerollSchema).default([]),
  });

  it('无 form 时 worldgenSchema 解析逐字节不变', () => {
    const inputs: unknown[] = [
      {},
      { seed: 3, type: 'continents' },
      { seed: 7, type: 'ocean', islands: 0.7, landFraction: 0.2, mountains: 1.5, rerolls: [{ x: 1.2, y: 0.4, radius: 0.08, variant: 2 }] },
      { type: 'archipelago', landFraction: undefined, extra: '丢掉' },
    ];
    for (const x of inputs) {
      const now = worldgenSchema.parse(x);
      expect(JSON.stringify(now)).toBe(JSON.stringify(oldSchema.parse(x)));
      expect(Object.keys(now)).toEqual(Object.keys(oldSchema.parse(x)));
      expect('form' in now).toBe(false);
    }
  });

  it('示例形态都能通过校验，解析后原样不变', () => {
    for (const f of FANTASY_FORMS) expect(planetFormSchema.parse(f)).toEqual(f);
    const parsed = worldgenSchema.parse({ seed: 1, type: 'continents', form: TWIN_CONTINENTS });
    expect(parsed.form).toEqual(TWIN_CONTINENTS);
  });

  it('不合理的形态被拒绝，说明是中文', () => {
    const bad = (patch: Record<string, unknown>) => planetFormSchema.safeParse({ ...TWIN_CONTINENTS, ...patch });
    expect(bad({ name: '一个非常非常非常长的星球形态名字' }).error?.issues[0].message).toBe('名字最多 12 个字');
    expect(bad({ name: '' }).success).toBe(false);
    expect(bad({ profile: { plates: [1, 5] } }).error?.issues[0].message).toBe('板块数最小是 2');
    expect(bad({ profile: { blocks: [5, 2] } }).error?.issues[0].message).toContain('前一个数不能比后一个大');
    expect(bad({ tuning: { beltWidth: 5 } }).error?.issues[0].message).toBe('山带宽窄最大是 3');
    expect(bad({ api: 2 }).success).toBe(false);
    expect(bad({ id: '双子' }).success).toBe(false);
    // 星球形态只用布局、地形两种脚本：别的种类解析时去掉
    const other = planetFormSchema.parse({ ...TWIN_CONTINENTS, scripts: { ...TWIN_CONTINENTS.scripts, placement: src('return 1;') } });
    expect(Object.keys(other.scripts!)).toEqual(['setup']);
  });
});

describe('声明式的部分', () => {
  it('什么都不改的形态与原来的星球逐位相同（倍数全为 1 也一样）', () => {
    const plain = terrainDigest(planet(4000, 3, 'continents'));
    const empty: PlanetForm = { id: 'same', name: '照旧', api: 1, base: 'continents' };
    expect(terrainDigest(planet(4000, 3, 'continents', empty))).toEqual(plain);
    const ones: PlanetForm = { ...empty, tuning: { beltWidth: 1, ridge: 1, trench: 1, rift: 1, hills: 1 }, crustMode: 'modify' };
    expect(terrainDigest(planet(4000, 3, 'continents', ones))).toEqual(plain);
  });

  it('配方与倍数生效', () => {
    const base: PlanetForm = { id: 'k', name: '试', api: 1, base: 'continents' };
    const plain = planet(4000, 3, 'continents');
    const less = planet(4000, 3, 'continents', { ...base, profile: { landFraction: 0.15 } });
    expect(landParts(less).frac).toBeLessThan(landParts(plain).frac - 0.08);
    const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    const wide = ensureBase(planet(4000, 3, 'continents', { ...base, tuning: { beltWidth: 2 } })).components!;
    const plainComp = ensureBase(plain).components!;
    expect(sum(wide.mountU)).toBeGreaterThan(sum(plainComp.mountU) * 1.3);
  });

  it('crustMode replace：地形脚本算了才不算板块边界；没有脚本、脚本出错、安全模式都按没有脚本算', () => {
    const base: PlanetForm = { id: 'k', name: '试', api: 1, base: 'continents' };
    const plain = terrainDigest(planet(4000, 3, 'continents'));
    // 脚本照原样返回：板块边界的山带都没有了
    const flat = ensureBase(planet(4000, 3, 'continents', { ...base, crustMode: 'replace', scripts: { crust: src('return height;') } })).components!;
    expect(flat.mountU.every((v) => v === 0)).toBe(true);
    // 没有地形脚本：replace 不起作用
    expect(terrainDigest(planet(4000, 3, 'continents', { ...base, crustMode: 'replace' }))).toEqual(plain);
    // 脚本出错：整遍按没有脚本算，山带照旧（与没有形态的星球逐位相同），问题记下
    const brokenForm: PlanetForm = { ...base, crustMode: 'replace', scripts: { crust: src('return lat > 80 ? NaN : height;') } };
    const broken = planet(4000, 3, 'continents', brokenForm);
    expect(terrainDigest(broken)).toEqual(plain);
    expect(planetFormIssues(broken).map((x) => x.reason)).toEqual(['value']);
    // 出错之后重画一片（局部重算）：原来的那一遍仍按没有脚本算（圈外的山带照旧），重画的那一遍（圈里没有北纬 80° 以上的格）
    // 脚本正常、不算板块边界；与从头算的相同
    const reroll = { x: 0.9, y: 0.3, radius: 0.1, variant: 4 };
    broken.small.terrain.gen = { ...broken.small.terrain.gen!, rerolls: [reroll] };
    resolveTerrain(broken);
    expect(terrainDigest(broken)).toEqual(terrainDigest(planet(4000, 3, 'continents', brokenForm, {}, [reroll])));
    expect(planetFormIssues(broken).map((x) => x.reason)).toEqual(['value']);
    const comp = ensureBase(broken).components!;
    const ref = ensureBase(planet(4000, 3, 'continents', undefined, {}, [reroll])).components!;
    const center = nearestCell(broken.mesh as SphereMesh, reroll.x, reroll.y, -1);
    const far = nearestCell(broken.mesh as SphereMesh, reroll.x + 1, 1 - reroll.y, -1);
    expect(comp.mountU[center]).toBe(0);
    expect(comp.mountU[far]).toBe(ref.mountU[far]);
    expect(comp.b0[far]).toBe(ref.b0[far]);
    // 安全模式：脚本不运行，山带照旧
    setScriptsEnabled(false);
    try {
      expect(terrainDigest(planet(4000, 3, 'continents', { ...base, crustMode: 'replace', scripts: { crust: src('return height;') } }))).toEqual(plain);
    } finally {
      setScriptsEnabled(true);
    }
  });
});

describe('布局脚本', () => {
  it('双子大陆：恰两个大陆块组件、陆地比例接近设定', () => {
    for (const seed of [1, 2, 3]) {
      const w = planet(8000, seed, 'continents', TWIN_CONTINENTS);
      const { frac, parts } = landParts(w);
      expect(parts.filter((p) => p > 0.1).length, `种子 ${seed}`).toBe(2);
      expect(Math.abs(frac - 0.18), `种子 ${seed}：陆地 ${frac}`).toBeLessThan(0.04);
      expect(planetFormIssues(w)).toEqual([]);
    }
  });

  it('加的岛总是露出来（岛多少为 0 也是）；clearIslands 不要原来的火山锥', () => {
    const form: PlanetForm = {
      id: 'lone',
      name: '孤岛',
      api: 1,
      base: 'ocean',
      profile: { islands: 0 },
      scripts: { setup: src('addIsland({ lat: 0, lon: 0, height: 6500, size: 3 });') },
    };
    const w = planet(4000, 2, 'ocean', form);
    const h = nearestCell(w.mesh as SphereMesh, 1, 0.5, -1);
    expect(w.causes.land[h]).toBe(1);
    // 原来的火山锥：岛多少 0.7 时有很多岛；clearIslands 之后只剩脚本加的那一个
    const many = landParts(planet(4000, 2, 'ocean', undefined, { islands: 0.7 })).parts.length;
    expect(many).toBeGreaterThan(5);
    const only = planet(4000, 2, 'ocean', withScripts(form, { setup: src('clearIslands();\naddIsland({ lat: 0, lon: 0, height: 6500, size: 3 });') }, { profile: { islands: 0.7 } }));
    expect(landParts(only).parts.length).toBe(1);
    expect(only.causes.land[h]).toBe(1);
  });

  it('中文的函数名、参数名与英文的相同', () => {
    const en = planet(4000, 3, 'continents', withScripts(TWIN_CONTINENTS, { setup: src('addBlock({ lat: 10, lon: 20, size: 30, stretch: 2, angle: 45, lobes: false });\naddIsland({ lat: -5, lon: 100, height: 6000 });') }));
    const zh = planet(4000, 3, 'continents', withScripts(TWIN_CONTINENTS, { setup: src('加大陆块({ 纬度: 10, 经度: 20, 大小: 30, 拉长: 2, 方向: 45, 半岛: false });\n加岛({ 纬度: -5, 经度: 100, 高度: 6000 });') }));
    expect(terrainDigest(zh)).toEqual(terrainDigest(en));
    expect(planetFormIssues(zh)).toEqual([]);
    expect(terrainDigest(en)).not.toEqual(terrainDigest(planet(4000, 3, 'continents', noScripts(TWIN_CONTINENTS))));
  });

  it('出错的布局脚本整段按没有脚本：中途加的块不算，问题带行号', () => {
    const plain = terrainDigest(planet(4000, 4, 'continents', noScripts(TWIN_CONTINENTS)));
    const cases: [string, string][] = [
      ['for (let k = 0; k < 200; k++) addBlock({ lat: 0, lon: k, size: 5 });', '大陆块最多 120 块'],
      ['addBlock({ lat: 10, lon: 0, size: 30 });\naddBlock({ lat: 100, lon: 0, size: 30 });', 'lat（纬度）要在 -90 到 90 之间'],
      ['addBlock({ lat: 10, lon: 0, size: 30 });\nconst x = undefined;\nreturn x.y;', '读不到'],
      ['addBlock({ lat: 10, lon: 0, size: 30, lobes: "要" });', 'lobes（半岛）要是 true 或 false'],
    ];
    for (const [code, text] of cases) {
      const w = planet(4000, 4, 'continents', withScripts(TWIN_CONTINENTS, { setup: src(code) }));
      expect(terrainDigest(w), code).toEqual(plain);
      const issues = planetFormIssues(w);
      expect(issues.length).toBe(1);
      expect(issues[0].kind).toBe('setup');
      expect(issues[0].message).toContain(text);
    }
    const w = planet(4000, 4, 'continents', withScripts(TWIN_CONTINENTS, { setup: src('addBlock({ lat: 10, lon: 0, size: 30 });\nconst x = undefined;\nreturn x.y;') }));
    expect(planetFormIssues(w)[0].line).toBe(3);
  });
});

describe('地形脚本', () => {
  it('crust 输出 NaN → 软失败、地形照常、问题被记下', () => {
    const none = terrainDigest(planet(4000, 5, 'continents', noScripts(POLAR_CONTINENTS)));
    const setupOnly = withScripts(POLAR_CONTINENTS, { setup: POLAR_CONTINENTS.scripts!.setup });
    const plain = terrainDigest(planet(4000, 5, 'continents', setupOnly));
    expect(plain).not.toEqual(none);
    for (const code of ['return NaN;', 'return { height: NaN };', 'return "高";', 'throw new Error("不行");', 'return height + 0;']) {
      const w = planet(4000, 5, 'continents', withScripts(POLAR_CONTINENTS, { ...setupOnly.scripts, crust: src(code) }));
      expect(terrainDigest(w), code).toEqual(plain);
      const issues = planetFormIssues(w);
      if (code === 'return height + 0;') expect(issues).toEqual([]);
      else {
        expect(issues.length, code).toBe(1);
        expect(issues[0].kind).toBe('crust');
        expect(issues[0].reason).toBe(code.startsWith('throw') ? 'runtime' : 'value');
      }
    }
  });

  it('星球的半径、轴倾角这些不给形态的脚本（改它们不重算地形）：说明哪几种脚本能用', () => {
    expect(scriptVariablesFor('crust').map((v) => v.key)).not.toContain('tilt');
    expect(scriptVariablesFor('setup').map((v) => v.key)).not.toContain('radiusKm');
    expect(scriptVariablesFor('crust').map((v) => v.key)).toContain('seed');
    const w = planet(4000, 5, 'continents', withScripts(POLAR_CONTINENTS, { crust: src('return height + tilt;') }));
    expect(planetFormIssues(w)[0].message).toContain('地形脚本里没有变量 tilt（只有');
    const v = planet(4000, 5, 'continents', withScripts(POLAR_CONTINENTS, { setup: src('addBlock({ lat: 0, lon: 0, size: radiusKm / 300 });') }));
    expect(planetFormIssues(v)[0].message).toContain('布局脚本里没有变量 radiusKm（只有');
  });

  // 带着这些重画从头算一遍
  const fresh =(gen: World['small']['terrain']['gen']) => {
    const w = createWorld(globe(4000), meshOf(4000));
    w.small.terrain.gen = gen;
    resolveTerrain(w);
    return w;
  };

  // 地形脚本运行了几次（每运行一遍取一次编译好的脚本）
  const runs = () => scriptStats.compiles + scriptStats.hits;

  it('一格出错整遍按没有脚本；重画一片（局部重算）与从头算逐值相同', () => {
    const base = withScripts(POLAR_CONTINENTS, { setup: POLAR_CONTINENTS.scripts!.setup });
    const plain = ensureBase(planet(4000, 6, 'continents', base)).components!;
    // 处处正常：每格抬高 300 m
    const up = withScripts(POLAR_CONTINENTS, { ...base.scripts, crust: src('return { height: height + 300 };') });
    const w = planet(4000, 6, 'continents', up);
    const comp = ensureBase(w).components!;
    for (let i = 0; i < w.mesh.n; i++) expect(Math.abs(comp.b0[i] - plain.b0[i] - 300)).toBeLessThan(0.01);
    const reroll = { x: 1.3, y: 0.15, radius: 0.12, variant: 3 };
    w.small.terrain.gen = { ...w.small.terrain.gen!, rerolls: [reroll] };
    let before = runs();
    resolveTerrain(w);
    // 局部重算：原来的噪声那一遍只对圈里的格运行一次，新的重画那一遍一次
    expect(runs() - before).toBe(2);
    expect(terrainDigest(w)).toEqual(terrainDigest(fresh(w.small.terrain.gen)));
    // 只有北纬 85° 以上的几格出错：整个星球按没有脚本算
    const bad = withScripts(POLAR_CONTINENTS, { ...base.scripts, crust: src('return lat > 85 ? NaN : { height: height + 300 };') });
    const v = planet(4000, 6, 'continents', bad);
    expect(Array.from(ensureBase(v).components!.b0)).toEqual(Array.from(plain.b0));
    expect(planetFormIssues(v).map((x) => x.reason)).toEqual(['value']);
    // 原来的噪声那一遍出过错：重画一片时那一遍不再运行（仍按没有脚本算），只运行新的重画那一遍；与从头算的相同
    v.small.terrain.gen = { ...v.small.terrain.gen!, rerolls: [reroll] };
    before = runs();
    resolveTerrain(v);
    expect(runs() - before).toBe(1);
    expect(terrainDigest(v)).toEqual(terrainDigest(fresh(v.small.terrain.gen)));
    expect(planetFormIssues(v)).toEqual(planetFormIssues(fresh(v.small.terrain.gen)));
    expect(planetFormIssues(v).length).toBe(1);
    // 撤掉这次重画（局部重算回去）：与从头算的相同
    v.small.terrain.gen = { ...v.small.terrain.gen!, rerolls: [] };
    resolveTerrain(v);
    expect(Array.from(ensureBase(v).components!.b0)).toEqual(Array.from(plain.b0));
  });

  it('局部重算时新的重画那一遍出错：只这一遍按没有脚本算，结果与从头算的相同', () => {
    const base = withScripts(POLAR_CONTINENTS, { setup: POLAR_CONTINENTS.scripts!.setup });
    // 先量出原来的噪声下北纬 50° 以上大陆场的最大值（脚本把大陆场写进高度）
    const probe = ensureBase(planet(4000, 7, 'continents', withScripts(POLAR_CONTINENTS, { ...base.scripts, crust: src('return lat > 50 ? { height: continent * 1000 } : -11000;') }))).components!;
    const top = Math.max(...probe.b0) + 0.5;
    // 原来的那一遍不会出错；换了噪声的重画可能让大陆场超过它
    const form = withScripts(POLAR_CONTINENTS, { ...base.scripts, crust: src(`return lat > 50 && continent * 1000 > ${top} ? NaN : { height: height + 300 };`) });
    let found = 0;
    for (let variant = 1; variant <= 40 && !found; variant++) {
      const w = planet(4000, 7, 'continents', form);
      expect(planetFormIssues(w)).toEqual([]);
      w.small.terrain.gen = { ...w.small.terrain.gen!, rerolls: [{ x: 0.6, y: 0.12, radius: 0.1, variant }] };
      resolveTerrain(w);
      if (!planetFormIssues(w).length) continue;
      found = variant;
      const again = fresh(w.small.terrain.gen);
      expect(terrainDigest(w)).toEqual(terrainDigest(again));
      expect(planetFormIssues(w)).toEqual(planetFormIssues(again));
      // 只是重画的那一遍按没有脚本算：圈外仍是脚本抬高了 300 m 的
      const comp = ensureBase(w).components!;
      const noScript = ensureBase(planet(4000, 7, 'continents', base)).components!;
      const far = [...Array(w.mesh.n).keys()].filter((i) => w.mesh.x[i] > 1.5 && Math.abs(w.mesh.y[i] - 0.5) < 0.2);
      for (const i of far) expect(Math.abs(comp.b0[i] - noScript.b0[i] - 300)).toBeLessThan(0.01);
      // 再加一次重画：出过错的那一遍照用上一次的结果，不再运行；与从头算的相同
      w.small.terrain.gen = { ...w.small.terrain.gen!, rerolls: [...w.small.terrain.gen!.rerolls, { x: 1.7, y: 0.6, radius: 0.08, variant: 99 }] };
      const before = runs();
      resolveTerrain(w);
      expect(runs() - before).toBeLessThanOrEqual(2);
      expect(terrainDigest(w)).toEqual(terrainDigest(fresh(w.small.terrain.gen)));
      expect(planetFormIssues(w)).toEqual(planetFormIssues(fresh(w.small.terrain.gen)));
    }
    expect(found).toBeGreaterThan(0);
  });

  it('极地大陆：两极的陆地多', () => {
    const w = planet(8000, 2, 'continents', POLAR_CONTINENTS);
    let polar = 0;
    let polarN = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (Math.abs(90 - 180 * w.mesh.y[i]) <= 65) continue;
      polarN++;
      polar += w.causes.land[i];
    }
    expect(polar / polarN).toBeGreaterThan(0.5);
    expect(planetFormIssues(w)).toEqual([]);
  });
});

describe('缓存与一致', () => {
  it('缩略图（4000 格）与 8000 格成品陆地重叠 ≥ 85%', () => {
    const pts = samples(4000);
    for (const form of FANTASY_FORMS) {
      for (const seed of [1, 2]) {
        const small = planet(4000, seed, form.base, form);
        const big = planet(8000, seed, form.base, form);
        let agree = 0;
        let hs = -1;
        let hb = -1;
        for (const [x, y] of pts) {
          hs = nearestCell(small.mesh as SphereMesh, x, y, hs);
          hb = nearestCell(big.mesh as SphereMesh, x, y, hb);
          if (small.causes.land[hs] === big.causes.land[hb]) agree++;
        }
        expect(agree / pts.length, `${form.name} 种子 ${seed}`).toBeGreaterThanOrEqual(0.85);
      }
    }
  });

  it('换形态同种子不复用旧模型', () => {
    const w = planet(4000, 8, 'continents', TWIN_CONTINENTS);
    const twin = terrainDigest(w);
    const gen = w.small.terrain.gen!;
    w.small.terrain.gen = { ...gen, form: POLAR_CONTINENTS };
    resolveTerrain(w);
    expect(terrainDigest(w)).toEqual(terrainDigest(planet(4000, 8, 'continents', POLAR_CONTINENTS)));
    // 只改了形态的一处脚本也换模型
    w.small.terrain.gen = { ...gen, form: withScripts(TWIN_CONTINENTS, { setup: src(TWIN_CONTINENTS.scripts!.setup!.src.replace('size: 36', 'size: 30')) }) };
    resolveTerrain(w);
    expect(terrainDigest(w)).not.toEqual(twin);
    // 去掉形态：回到原来的星球
    w.small.terrain.gen = { ...gen, form: undefined };
    resolveTerrain(w);
    expect(terrainDigest(w)).toEqual(terrainDigest(planet(4000, 8, 'continents')));
  });

  it('安全模式下形态的声明部分仍生效、脚本跳过', () => {
    const w = createWorld(globe(4000), meshOf(4000));
    w.small.terrain.gen = { seed: 9, type: 'continents', mountains: 1, rerolls: [], form: POLAR_CONTINENTS };
    let safe: ReturnType<typeof terrainDigest>;
    setScriptsEnabled(false);
    try {
      resolveTerrain(w);
      safe = terrainDigest(w);
      expect(safe).toEqual(terrainDigest(planet(4000, 9, 'continents', noScripts(POLAR_CONTINENTS))));
      expect(safe).not.toEqual(terrainDigest(planet(4000, 9, 'continents')));
      // 与生态的脚本一样，安全模式下跳过的脚本不记问题（安全模式有自己的横幅）
      expect(planetFormIssues(w)).toEqual([]);
    } finally {
      setScriptsEnabled(true);
    }
    // 同一个世界打开脚本后重新算（安全模式的模型不会被拿来用）
    resolveTerrain(w);
    expect(terrainDigest(w)).not.toEqual(safe);
    expect(terrainDigest(w)).toEqual(terrainDigest(planet(4000, 9, 'continents', POLAR_CONTINENTS)));
    expect(planetFormIssues(w)).toEqual([]);
  });
});

describe('命令', () => {
  const settings = globe(4000);

  it('set_worldgen：只能用在整个星球上、type 要与 base 相同、语法错误当场拒绝', () => {
    const region = engineFor({ cells: 3000, seed: 1 });
    expect(() => region.exec({ op: 'set_worldgen', params: { seed: 1, type: 'continents', form: TWIN_CONTINENTS }, reset: true })).toThrow('星球形态只能用在整个星球上');
    const eng = engineFor(settings);
    expect(() => eng.exec({ op: 'set_worldgen', params: { seed: 1, type: 'continent', form: TWIN_CONTINENTS }, reset: true })).toThrow('星球形态「双子大陆」只能用在“像地球”这种星球上，这里是“一块超大陆”');
    let err: unknown;
    try {
      eng.exec({ op: 'set_worldgen', params: { seed: 1, type: 'continents', form: withScripts(TWIN_CONTINENTS, { setup: src('const a = 1;\naddBlock({ lat: 0, lon: 0, size: 20 ) });') }) }, reset: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).message).toContain('「双子大陆」的布局脚本');
    expect(eng.history).toEqual([]);
    expect(eng.world.small.terrain.gen).toBeNull();
  });

  it('说明文字：形态的名字、星球类型的名字；换形态写进说明', () => {
    const eng = engineFor(settings);
    expect(eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true })).toBe('新世界：像地球');
    const gen = eng.world.small.terrain.gen!;
    expect(eng.exec({ op: 'set_worldgen', params: { ...gen, form: TWIN_CONTINENTS } })).toBe('换了星球形态：双子大陆');
    expect(eng.exec({ op: 'set_worldgen', params: { ...eng.world.small.terrain.gen!, landFraction: 0.2 } })).toBe('调整了陆地多少');
    expect(eng.exec({ op: 'set_worldgen', params: { ...gen, type: 'inland_sea', landFraction: 0.25, form: RING_SEA } })).toBe('换了星球形态：环形内海；调整了陆地多少');
    expect(eng.exec({ op: 'set_worldgen', params: { ...gen, type: 'inland_sea', landFraction: 0.25 } })).toBe('去掉了星球形态「环形内海」');
    expect(engineFor(settings).exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean', islands: 0.7 }, reset: true })).toBe('新世界：海洋星球');
    expect(engineFor(settings).exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean' }, reset: true })).toBe('新世界：空白星球');
    expect(engineFor({ cells: 3000, seed: 1 }).exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true })).toBe('新世界：几块大陆');
  });

  it('重放与撤销逐值一致（含地形脚本、重画一片、检查点）', () => {
    const form = withScripts(POLAR_CONTINENTS, { ...POLAR_CONTINENTS.scripts, crust: src('const polar = smoothstep(55, 80, Math.abs(lat));\nif (lat < -70 && rand() < 0.02) return NaN;\nreturn { height: height + 900 * polar * Math.max(0, continent), hills: hills * (1 + rand()) };') });
    const eng = engineFor(settings);
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents', form }, reset: true });
    const first = digestWorld(eng.world);
    expect(planetFormIssues(eng.world).some((x) => x.reason === 'value')).toBe(true);
    eng.exec({ op: 'generate_provinces', rules: { seed: 4 } });
    eng.exec({ op: 'reroll_region', x: 1.99, y: 0.85, radius: 0.1, variant: 1 });
    const cells = coastalStroke(eng.world, 0.4, 5);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
    eng.exec({ op: 'set_worldgen', params: { ...eng.world.small.terrain.gen!, landFraction: 0.36 } });
    eng.exec({ op: 'reroll_region', x: 0.4, y: 0.1, radius: 0.12, variant: 2 });
    eng.undo();
    eng.undo();
    eng.redo();
    const doc = eng.toDoc();
    expect(doc.version).toBe(5);
    const mesh = meshFor(settings);
    const replay = Engine.fromDoc(doc, mesh);
    expect(digestWorld(replay.world)).toEqual(digestWorld(eng.world));
    // 检查点恢复后再重画一片，与从头重放后再重画一片相同
    const restored = Engine.fromCheckpoint(eng.toCheckpoint(), doc, mesh)!;
    expect(restored).not.toBeNull();
    const more = { op: 'reroll_region' as const, x: 1.0, y: 0.9, radius: 0.1, variant: 5 };
    restored.exec(more);
    replay.exec(more);
    expect(digestWorld(restored.world)).toEqual(digestWorld(replay.world));
    expect(replay.world.derived.scriptIssues).toEqual(eng.world.derived.scriptIssues);
    expect(restored.world.derived.scriptIssues).toEqual(replay.world.derived.scriptIssues);
    // 一路撤销回到第一步之后
    while (eng.history.filter((h) => h.done).length > 1) eng.undo();
    expect(digestWorld(eng.world)).toEqual(first);
  });

  it('脚本出的问题记进 d.scriptIssues；从检查点恢复后只改生态，问题照样在', () => {
    const bad = withScripts(TWIN_CONTINENTS, { ...TWIN_CONTINENTS.scripts, crust: src('return lat < -60 ? NaN : height;') });
    const eng = engineFor(settings);
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', form: bad }, reset: true });
    const d = eng.update();
    expect(d.scriptIssues?.map((x) => [x.owner, x.kind, x.reason])).toEqual([['双子大陆', 'crust', 'value']]);
    expect(d.scriptIssues).toEqual(planetFormIssues(eng.world));
    // 从检查点恢复（地形没有重新组合过），再只改一种生态：问题与从头重放的相同
    const doc = eng.toDoc();
    const mesh = meshFor(settings);
    // 检查点存进 IndexedDB 时是结构化复制的
    const restored = Engine.fromCheckpoint(structuredClone(eng.toCheckpoint()), doc, mesh)!;
    const replay = Engine.fromDoc(doc, mesh);
    const edit = { op: 'update_species' as const, id: eng.world.small.species[0].id, patch: { competition: 1.3 } };
    restored.exec(edit);
    replay.exec(edit);
    expect(restored.update().scriptIssues).toEqual(replay.update().scriptIssues);
    expect(restored.world.derived.scriptIssues?.length).toBe(1);
    // 改好脚本：问题没了（键还在，值为 undefined）
    eng.exec({ op: 'set_worldgen', params: { ...eng.world.small.terrain.gen!, form: withScripts(bad, { ...bad.scripts, crust: src('return height;') }) } });
    expect(eng.update().scriptIssues).toBeUndefined();
    // 没有形态的星球：没有这个键
    const plain = engineFor(settings);
    plain.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    expect('scriptIssues' in plain.update()).toBe(false);
  });
});
