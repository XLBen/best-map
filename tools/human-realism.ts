// 人文像不像（第八十四轮）：几个种子 × 六个时代 × {一块地区、整个星球}，新建、划省份、生成人文（国家、城市、道路）以后量：
//   首都离本国人口重心多远（中位数，km 与 ÷ 国家半径 √(面积 / π)）；
//   城市落在宜居度 < 0.15 的格上的比例（荒漠、冰原上的城）；
//   国界沿着大河（流量 ≥ 10 × 画河的门槛）、高地（任一边 ≥ 1000 m）、山脊（分水岭：两边不在同一个流域、都高过 300 m）的比例
//   （另列全部陆上的边里这几种占多少，作对照）；
//   领土不连成一片的国家的比例（只数同一块陆地上被隔开的：隔海的、殖民地、公司领地是有意的，不算）；
//   宗教：每个文化组里占到一成以上格的宗教有几种（平均），每格的主要宗教与邻格里最多的那种相同的比例（成片的程度），
//   每种宗教连成几片（至少 5 格，平均）；
//   连着海路的港口、海路的条数（第八十四轮以后才有）。
//   npx tsx tools/human-realism.ts [--seeds 3,7,11] [--eras antiquity,medieval,...] [--only region|globe] [--cells 30000] [--json 文件]
// 这个文件要能在旧的提交上跑：只用那时已有的接口
import { writeFileSync } from 'node:fs';
import { Engine } from '../core/engine';
import type { Command } from '../core/commands';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { planetSettings } from '../core/presets';
import { kindOf } from '../core/content/registry';
import { cellKm2, distKm } from '../core/human/space';
import type { World } from '../core/world';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const k = argv.indexOf(name);
  return k >= 0 ? argv[k + 1] : undefined;
};
const seeds = (opt('--seeds') ?? '3,7,11').split(',').map(Number);
const eras = (opt('--eras') ?? 'antiquity,medieval,industrial,modern,fantasy,scifi').split(',');
const only = opt('--only');
const cells = Number(opt('--cells') ?? 30000);
const jsonOut = opt('--json');

const groupsOf = (era: string) => ((builtinPacks().find((p) => p.id === era)?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 4).map((n) => n.id);

function build(globe: boolean, seed: number, era: string): Engine {
  const settings = globe ? { ...planetSettings('earth'), seed } : { seed, cells };
  const eng = new Engine(settings);
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed, type: 'continents' }, reset: true }] } as Command);
  for (const c of packImportCommands(builtinPacks(), { packs: [[era]] }, eng.world)) eng.exec(c);
  eng.exec((kindOf('provinceRules') ? { op: 'generate_provinces', seed } : { op: 'generate_provinces', rules: { seed } }) as unknown as Command);
  eng.exec({ op: 'generate_human', packs: [[era]], groups: groupsOf(era), countries: {}, settlements: {} } as unknown as Command);
  eng.update();
  return eng;
}

const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

interface Row {
  countries: number;
  capKm: number;
  capFrac: number;
  cities: number;
  desertCities: number;
  borderRiver: number;
  borderHigh: number;
  borderRidge: number;
  baseRiver: number;
  baseHigh: number;
  baseRidge: number;
  split: number;
  religions: number;
  coherence: number;
  patches: number;
  ports: number;
  seaLanes: number;
}

function measure(w: World): Row {
  const { mesh, causes, derived: d, small } = w;
  const n = mesh.n;
  const country = causes.country;
  const pop = causes.popTotal;
  const sphere = mesh.kind === 'sphere';
  const dry = (i: number) => causes.land[i] === 1 && d.lake[i] !== 1;
  // ---- 首都与人口重心 ----
  const acc = new Map<number, { w: number; x: number; y: number; z: number; a: number }>();
  if (country && pop) {
    for (let i = 0; i < n; i++) {
      const c = country[i];
      if (c < 0 || !dry(i)) continue;
      let r = acc.get(c);
      if (!r) acc.set(c, (r = { w: 0, x: 0, y: 0, z: 0, a: 0 }));
      r.a += cellKm2(w, i);
      const p = pop[i];
      if (!(p > 0)) continue;
      r.w += p;
      if (sphere) {
        r.x += p * mesh.p[3 * i];
        r.y += p * mesh.p[3 * i + 1];
        r.z += p * mesh.p[3 * i + 2];
      } else {
        r.x += p * mesh.x[i];
        r.y += p * mesh.y[i];
      }
    }
  }
  const capKm: number[] = [];
  const capFrac: number[] = [];
  for (const m of Object.values(small.countries ?? {})) {
    const r = acc.get(m.id);
    if (!r || !(r.w > 0) || m.capitalCell === undefined) continue;
    const i = m.capitalCell;
    let km: number;
    if (sphere) {
      const L = Math.hypot(r.x, r.y, r.z) || 1;
      const dot = (r.x * mesh.p[3 * i] + r.y * mesh.p[3 * i + 1] + r.z * mesh.p[3 * i + 2]) / L;
      km = (Math.acos(Math.max(-1, Math.min(1, dot))) * w.kmPerUnit) / Math.PI;
    } else km = Math.hypot(r.x / r.w - mesh.x[i], r.y / r.w - mesh.y[i]) * w.kmPerUnit;
    capKm.push(km);
    capFrac.push(km / Math.sqrt(r.a / Math.PI));
  }
  // ---- 城市 ----
  const cityList = Object.values(small.cities ?? {});
  const desert = cityList.filter((c) => d.habitability[c.cell] < 0.15).length;
  // ---- 国界 ----
  const thr = small.planet.riverThreshold;
  const major = (i: number) => d.lake[i] !== 1 && d.discharge[i] >= 10 * thr;
  const high = (i: number) => d.elevation[i] >= 1000;
  let bLen = 0;
  let bRiver = 0;
  let bHigh = 0;
  let aLen = 0;
  let aRiver = 0;
  let aHigh = 0;
  let bRidge = 0;
  let aRidge = 0;
  for (let i = 0; i < n; i++) {
    if (!dry(i)) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (j < i || !dry(j)) continue;
      const L = mesh.edgeLen ? mesh.edgeLen[e] : mesh.dist[e];
      const riv = major(i) || major(j);
      const hi = high(i) || high(j);
      const ridge = d.basin[i] !== d.basin[j] && Math.min(d.elevation[i], d.elevation[j]) > 300;
      aLen += L;
      if (riv) aRiver += L;
      if (hi) aHigh += L;
      if (ridge) aRidge += L;
      if (country && country[i] >= 0 && country[j] >= 0 && country[i] !== country[j]) {
        bLen += L;
        if (riv) bRiver += L;
        if (hi) bHigh += L;
        if (ridge) bRidge += L;
      }
    }
  }
  // ---- 不连成一片（同一块陆地上） ----
  const comp = new Int32Array(n).fill(-1);
  let nc = 0;
  for (let s = 0; s < n; s++) {
    if (!causes.land[s] || comp[s] >= 0) continue;
    const st = [s];
    comp[s] = nc;
    while (st.length) {
      const i = st.pop()!;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (causes.land[j] && comp[j] < 0) {
          comp[j] = nc;
          st.push(j);
        }
      }
    }
    nc++;
  }
  let split = 0;
  let counted = 0;
  if (country) {
    const piece = new Int32Array(n).fill(-1);
    const pieces = new Map<number, Map<number, number>>();
    let np = 0;
    for (let s = 0; s < n; s++) {
      const c = country[s];
      if (c < 0 || !causes.land[s] || piece[s] >= 0) continue;
      const st = [s];
      piece[s] = np;
      let size = 0;
      while (st.length) {
        const i = st.pop()!;
        size++;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (causes.land[j] && country[j] === c && piece[j] < 0) {
            piece[j] = np;
            st.push(j);
          }
        }
      }
      np++;
      let m = pieces.get(c);
      if (!m) pieces.set(c, (m = new Map()));
      m.set(comp[s], (m.get(comp[s]) ?? 0) + 1);
    }
    for (const m of Object.values(small.countries ?? {})) {
      if (m.subject === 'colony' || m.subject === 'company') continue;
      const p = pieces.get(m.id);
      if (!p) continue;
      counted++;
      if ([...p.values()].some((k) => k > 1)) split++;
    }
  }
  // ---- 宗教 ----
  let religions = NaN;
  let coherence = NaN;
  let patches = NaN;
  const groups = small.popGroups;
  const dimIds = new Set((small.content?.era ? Object.values(small.content.era as Record<string, { dimensions: { id: string }[] }>).flatMap((e) => e.dimensions.map((x) => x.id)) : []));
  if (pop && groups && causes.popGroup && dimIds.has('religion')) {
    const rel = new Int32Array(n).fill(-1);
    const relId = new Map<string, number>();
    const grp = new Int32Array(n).fill(-1);
    const grpId = new Map<string, number>();
    const cultures = small.content?.culture as Record<string, { group: string }> | undefined;
    for (let i = 0; i < n; i++) {
      if (!(pop[i] > 0)) continue;
      const t = groups[causes.popGroup[i * 4]];
      const r = t?.values?.religion;
      if (!t || !r) continue;
      if (!relId.has(r)) relId.set(r, relId.size);
      rel[i] = relId.get(r)!;
      const g = cultures?.[t.culture]?.group ?? t.culture;
      if (!grpId.has(g)) grpId.set(g, grpId.size);
      grp[i] = grpId.get(g)!;
    }
    // 每个组里占一成以上格的宗教
    const tally = new Map<number, Map<number, number>>();
    for (let i = 0; i < n; i++) {
      if (rel[i] < 0) continue;
      let m = tally.get(grp[i]);
      if (!m) tally.set(grp[i], (m = new Map()));
      m.set(rel[i], (m.get(rel[i]) ?? 0) + 1);
    }
    const per: number[] = [];
    for (const m of tally.values()) {
      let s = 0;
      for (const v of m.values()) s += v;
      if (s < 20) continue;
      per.push([...m.values()].filter((v) => v >= 0.1 * s).length);
    }
    religions = per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
    let same = 0;
    let tot = 0;
    const cnt = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (rel[i] < 0) continue;
      cnt.clear();
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (rel[j] >= 0) cnt.set(rel[j], (cnt.get(rel[j]) ?? 0) + 1);
      }
      if (!cnt.size) continue;
      let best = -1;
      let bc = -1;
      for (const [k, v] of cnt) if (v > bc || (v === bc && k === rel[i])) {
        best = k;
        bc = v;
      }
      tot++;
      if (best === rel[i]) same++;
    }
    coherence = tot ? same / tot : NaN;
    // 每种宗教连成几片（至少 5 格的片）
    const seenR = new Uint8Array(n);
    const per2 = new Map<number, number>();
    for (let s0 = 0; s0 < n; s0++) {
      if (rel[s0] < 0 || seenR[s0]) continue;
      const st = [s0];
      seenR[s0] = 1;
      let size = 0;
      while (st.length) {
        const i = st.pop()!;
        size++;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (!seenR[j] && rel[j] === rel[s0]) {
            seenR[j] = 1;
            st.push(j);
          }
        }
      }
      if (size >= 5) per2.set(rel[s0], (per2.get(rel[s0]) ?? 0) + 1);
    }
    patches = per2.size ? [...per2.values()].reduce((a, b) => a + b, 0) / per2.size : NaN;
  }
  const roads = Object.values(small.roads ?? {});
  return {
    countries: Object.keys(small.countries ?? {}).length,
    capKm: median(capKm),
    capFrac: median(capFrac),
    cities: cityList.length,
    desertCities: cityList.length ? desert / cityList.length : NaN,
    borderRiver: bLen ? bRiver / bLen : NaN,
    borderHigh: bLen ? bHigh / bLen : NaN,
    baseRiver: aLen ? aRiver / aLen : NaN,
    baseHigh: aLen ? aHigh / aLen : NaN,
    borderRidge: bLen ? bRidge / bLen : NaN,
    baseRidge: aLen ? aRidge / aLen : NaN,
    split: counted ? split / counted : NaN,
    religions,
    coherence,
    patches,
    ports: new Set(roads.filter((r) => r.kind === 'sea').flatMap((r) => [r.cells[0], r.cells[r.cells.length - 1]])).size,
    seaLanes: roads.filter((r) => r.kind === 'sea').length,
  };
}

const KEYS: (keyof Row)[] = ['countries', 'capKm', 'capFrac', 'cities', 'desertCities', 'borderRiver', 'baseRiver', 'borderHigh', 'baseHigh', 'borderRidge', 'baseRidge', 'split', 'religions', 'coherence', 'patches', 'ports', 'seaLanes'];
const mean = (rows: Row[], k: keyof Row) => {
  const v = rows.map((r) => r[k]).filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
const fmt = (k: keyof Row, v: number) => (!Number.isFinite(v) ? '—' : ['countries', 'cities', 'ports', 'seaLanes', 'capKm'].includes(k) ? v.toFixed(0) : k === 'religions' || k === 'capFrac' || k === 'patches' ? v.toFixed(2) : `${(v * 100).toFixed(1)}%`);

const out: Record<string, Record<string, number>> = {};
for (const kind of ['region', 'globe'].filter((k) => !only || k === only)) {
  console.log(`\n## ${kind === 'region' ? `一块地区（${cells} 格）` : '整个星球'}，种子 ${seeds.join('、')} 的平均\n`);
  console.log(`| 时代 | ${KEYS.join(' | ')} |`);
  console.log(`|---|${KEYS.map(() => '---:').join('|')}|`);
  const all: Row[] = [];
  for (const era of eras) {
    const rows: Row[] = [];
    for (const seed of seeds) rows.push(measure(build(kind === 'globe', seed, era).world));
    all.push(...rows);
    out[`${kind}:${era}`] = Object.fromEntries(KEYS.map((k) => [k, mean(rows, k)]));
    console.log(`| ${era} | ${KEYS.map((k) => fmt(k, mean(rows, k))).join(' | ')} |`);
  }
  out[`${kind}:all`] = Object.fromEntries(KEYS.map((k) => [k, mean(all, k)]));
  console.log(`| 全部 | ${KEYS.map((k) => fmt(k, mean(all, k))).join(' | ')} |`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
