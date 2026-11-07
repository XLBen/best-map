// 合成着色器逐字节对照（第三十九轮）的页面那一半：tools/compose-ab.mjs 把它和两份渲染器（旧的提交的、现在的）打包成一个
// file:// 页面，在无头 Chrome（SwiftShader）里跑。同一个世界、同一份图层（现在的 colors.ts 算的，两边都给同一个对象）、
// 同样的镜头与设置，两个渲染器各画到自己的画布上，读回来的像素逐字节比。
//   世界：一块地区（1.2 万格、省份、中世纪的人文与国家、有帝国、领海，横切一个大省留下剪刀切线）与整个星球（4000 格，同样有人文）。
//   模式：地貌、省份、国家、同盟、文化、每一维、人口（国界淡的几种）；省份工具（省份的高亮、按省份取格）另算一组。
//   画法：停稳（几种缩放：一格约 3、8、24、48 个像素）、移动中（低分辨率的场景挪用）、星球上的等面积与球形投影、导出的一块。
//   描格：先不描，再描鼠标下的格与钉住的格，换一格，再不描——新的渲染器后三次都只重画描格那几块（第三十九轮的“描格那一遍”），
//   旧的整张重画；两边逐字节相同。
// 结果写进页面的 <pre id="o">（一行一组：不同的字节数）；最后一行 “DONE 共 N 组，不同 M 组”。
import { continents, fragKm2, humanExec, seededEngine } from '../core/testing/fixtures';
import type { Engine } from '../core/engine';
import { dropWaterTypes } from './r40-world';
import { scissors } from '../core/seams';
import { worldDimensions } from '../core/human';
import { findCell } from '../core/mesh';
import type { World } from '../core/world';
import type { ViewMode } from '../src/state';
import { cellLayers, highlightColors, provinceScale } from '../src/render/colors';
import { tileView } from '../src/render/export-plan';
import { BUILTIN_ERAS } from '../core/packs/eras';

// 两份渲染器共有的那些（旧的提交上的类型与现在的不一样，按用到的几样写）
interface AnyRenderer {
  camera: { x: number; y: number; zoom: number; proj?: { kind: 'equalEarth' | 'globe'; lon0: number; lat0: number } };
  flatByGroup: boolean;
  highlightByGroup: boolean;
  provinceAlpha: number;
  countryAlpha: number;
  provinceScale: number;
  setMesh(m: World['mesh']): void;
  setLayers(l: unknown): void;
  setHighlight(h: Uint8Array | null): void;
  setFocus(a: { cell: number; land: boolean } | null, b: { cell: number; land: boolean } | null): void;
  render(km: number, o?: { still?: boolean }): boolean;
  renderTile(km: number, tv: unknown, T: number, zoom: number, dpr: number): Uint8Array;
  prepareNear?: () => void;
}
type Ctor = new (c: HTMLCanvasElement) => AnyRenderer;

// 第四十三轮：EU4 的文化组
const GROUPS = [
  { id: 'chinese', weight: 4 },
  { id: 'levantine', weight: 3 },
  { id: 'germanic', weight: 3 },
];

// 横切一个大的陆地省（同 core/display-cell.test.ts 的 cutBig）
function cutBig(eng: Engine) {
  const w = eng.world;
  const { mesh } = w;
  const sphere = mesh.kind === 'sphere';
  const sizes = new Map<number, number>();
  w.causes.province.forEach((p) => p >= 0 && sizes.set(p, (sizes.get(p) ?? 0) + 1));
  const bigs = [...sizes].filter(([p]) => w.small.provinces[p]?.land).sort((a, b) => b[1] - a[1]);
  const s = mesh.spacing;
  for (const [big, size] of bigs.slice(0, 5)) {
    let sx = 0;
    let cx = 0;
    let cy = 0;
    w.causes.province.forEach((p, i) => {
      if (p !== big) return;
      sx += sphere ? Math.sin(Math.PI * mesh.x[i]) : mesh.x[i];
      cx += sphere ? Math.cos(Math.PI * mesh.x[i]) : 0;
      cy += mesh.y[i];
    });
    const x = sphere ? Math.atan2(sx, cx) / Math.PI : sx / size;
    const y = cy / size;
    const { line, cut } = scissors(w, [
      [x - 2 * s, y + 0.2 * s],
      [x + 2 * s, y - 0.1 * s],
    ]);
    if (!cut.plans.length) continue;
    eng.exec({ op: 'cut_province', line });
    return [x, y];
  }
  return null;
}

// 人文、国家（领海：离岸 seaKm 以内的海归国家；同 src/render/near.test.ts），再横切一个大省。
// fragmentation：以前重新生成国家时的“分裂 ↔ 统一”，第七十七轮起换成时代的国家大小（fragKm2，平均的国家面积逐值相同，画面也相同）
function peopled(e: Engine, seaKm: number, fragmentation?: number): number[] | null {
  humanExec(e, { op: 'generate_human', packs: [['medieval']], groups: GROUPS, countries: { seed: 3 } });
  const era = structuredClone(BUILTIN_ERAS.find((x) => x.id === 'medieval')!);
  e.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: { ...era, seaClaimKm: seaKm, ...(fragmentation !== undefined ? { countryKm2: fragKm2('medieval', fragmentation) } : {}) } });
  humanExec(e, { op: 'regenerate_countries' });
  return cutBig(e);
}

function worlds(plain = false): { label: string; eng: Engine; cut: number[] | null }[] {
  const region = continents({ provinces: true });
  const rc = peopled(region, 300);
  const planet = seededEngine({ cells: 12000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
  planet.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
  planet.exec({ op: 'generate_provinces', seed: 3 });
  const pc = peopled(planet, 400, 0.2);
  if (plain) {
    dropWaterTypes(region);
    dropWaterTypes(planet);
  }
  return [
    { label: 'region', eng: region, cut: rc },
    { label: 'planet', eng: planet, cut: pc },
  ];
}

// MapView 的设置（地图模式的表：国家模式省界 0.45、国界显眼；文化、每一维、人口、同盟省界 0.25、国界淡 0.4）
function settings(w: World, mode: ViewMode, provinceTool: boolean) {
  const human = mode === 'country' || mode === 'bloc' || mode === 'culture' || mode === 'cultureGroup' || mode === 'popDensity' || mode.startsWith('dim:');
  const layer = human && mode !== 'country';
  return {
    o: { mode, season: 'annual' as const, focusSpecies: null, borders: human || mode === 'provinces' || provinceTool, countryBorders: human && !!w.small.countries },
    flatByGroup: mode === 'provinces' || mode === 'country' || mode === 'bloc',
    highlightByGroup: provinceTool,
    provinceAlpha: human && !provinceTool ? (mode === 'country' ? 0.45 : 0.25) : 1,
    countryAlpha: layer ? 0.4 : 1,
  };
}

function pixels(c: HTMLCanvasElement): Uint8Array {
  const gl = c.getContext('webgl2')!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const px = new Uint8Array(c.width * c.height * 4);
  gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
function diff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// 一格国界上的格（两边国家不同的陆地格）与它旁边的一格：镜头放在这里，描格也描这两格
function borderCells(w: World): number[] {
  const { mesh, causes } = w;
  const c = w.derived.country;
  const out: number[] = [];
  if (!c) return out;
  for (let i = 0; i < mesh.n && out.length < 40; i += 7) {
    if (!causes.land[i] || !c[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (causes.land[j] && c[j] && c[j] !== c[i] && Math.abs(mesh.y[i] - 0.5) < 0.3) {
        out.push(i, j);
        break;
      }
    }
  }
  return out;
}

export function run(OldR: Ctor, NewR: Ctor, opts: { quick?: boolean; time?: boolean; plain?: boolean } = {}) {
  if (opts.time) {
    timing(OldR, NewR);
    return;
  }
  const out: string[] = [];
  const pre = document.getElementById('o')!;
  let cases = 0;
  let bad = 0;
  let focusChanged = 0;
  const t0 = performance.now();
  try {
    const W = 300;
    const H = 200;
    const mk = () => {
      const c = document.createElement('canvas');
      c.style.cssText = `width:${W}px;height:${H}px;display:block`;
      document.body.appendChild(c);
      return c;
    };
    const ca = mk();
    const cb = mk();
    const A = new OldR(ca);
    const B = new NewR(cb);
    const both = (f: (r: AnyRenderer) => void) => {
      f(A);
      f(B);
    };
    const check = (label: string) => {
      const a = pixels(ca);
      const b = pixels(cb);
      const d = diff(a, b);
      cases++;
      if (d) bad++;
      out.push(`${label}: ${d ? `DIFF ${d} bytes` : 'same'}`);
      return a;
    };
    for (const { label, eng, cut } of worlds(opts.plain)) {
      const w = eng.world;
      const { mesh } = w;
      both((r) => r.setMesh(mesh));
      B.prepareNear?.();
      const dims = worldDimensions(w.small).map((d) => `dim:${d.id}` as ViewMode);
      const modes: [ViewMode, boolean][] = [
        ['terrain', false],
        ['provinces', true],
        ['country', false],
        ['bloc', false],
        ['culture', false],
        ...(dims.length ? ([[dims[0], false]] as [ViewMode, boolean][]) : []),
        ['popDensity', false],
      ];
      const border = borderCells(w);
      const claims = w.derived.country ? [...Array(mesh.n).keys()].filter((i) => !w.causes.land[i] && w.derived.country![i]).length : 0;
      out.push(`# ${label}: ${mesh.n} 格，${Object.keys(w.small.countries ?? {}).length} 国，领海 ${claims} 格，切线 ${w.small.provinceSeams?.length ?? 0} 条，国界上的格 ${border.length / 2}`);
      const scale = provinceScale(w.causes.province);
      const zooms = opts.quick ? [8] : [3, 8, 24, 48];
      for (const [mode, provinceTool] of modes) {
        const st = settings(w, mode, provinceTool);
        const layers = cellLayers(w, st.o);
        both((r) => {
          r.setLayers(layers);
          r.flatByGroup = st.flatByGroup;
          r.highlightByGroup = st.highlightByGroup;
          r.provinceAlpha = st.provinceAlpha;
          r.countryAlpha = st.countryAlpha;
          r.provinceScale = scale;
        });
        // 新的渲染器在空闲时算离边界远的格：这里当场算好（页面一口气跑完，计时器不会走）
        B.prepareNear?.();
        const nb = B as unknown as { nearShown: Uint8Array | null; nearRho: Float32Array | null };
        out.push(`${label} ${mode}：离边界远的格 ${nb.nearShown && nb.nearRho ? '用上' : '没有'}`);
        // 省份工具：几个省的高亮（平涂、斜线、只描边）
        const hl = provinceTool
          ? highlightColors(w, [
              { cells: [...Array(mesh.n).keys()].filter((i) => w.causes.province[i] === w.causes.province[border[0] ?? 0]), color: [255, 200, 40], alpha: 0.4 },
              { cells: [...Array(mesh.n).keys()].filter((i) => w.causes.province[i] === w.causes.province[border[1] ?? 1]), color: [200, 40, 40], pattern: 'hatch' },
            ])
          : null;
        both((r) => r.setHighlight(hl));
        for (const z of zooms) {
          // 镜头：国界上的一格（第二个镜头在切线那里）
          const spots: [number, number][] = [[mesh.x[border[0] ?? 0], mesh.y[border[0] ?? 0]]];
          if (cut && z >= 8) spots.push([cut[0], cut[1]]);
          for (const [sx, sy] of spots) {
            both((r) => {
              r.camera = { x: sx, y: sy, zoom: z / mesh.spacing };
              r.setFocus(null, null);
            });
            const tag = `${label} ${mode}${provinceTool ? '+省份工具' : ''} 一格 ${z} 像素 @${sx.toFixed(3)},${sy.toFixed(3)}`;
            both((r) => r.render(w.kmPerUnit, { still: true }));
            const plain = check(`${tag} 不描`);
            // 描格的格：镜头中间的那一格、它的一个邻格、再隔一格的一格（都在画面上）
            const f1 = findCell(mesh, sx - 2 * Math.floor(sx / 2) * (mesh.kind === 'sphere' ? 1 : 0), sy);
            const f2 = mesh.adj[mesh.off[f1]];
            const f3 = mesh.adj[mesh.off[f2 + 1] - 1] === f1 ? mesh.adj[mesh.off[f2]] : mesh.adj[mesh.off[f2 + 1] - 1];
            for (const [fa, fb, name] of [
              [{ cell: f1, land: true }, { cell: f3, land: true }, '描鼠标下的格与钉住的格'],
              [{ cell: f2, land: true }, { cell: f3, land: true }, '鼠标换到旁边一格'],
              [null, { cell: f3, land: false }, '只剩钉住的格（水面的那一部分）'],
              [null, null, '不描'],
            ] as const) {
              both((r) => {
                r.setFocus(fa, fb);
                r.render(w.kmPerUnit, { still: true });
              });
              const px = check(`${tag} ${name}`);
              if (diff(px, plain)) focusChanged++;
            }
            // 移动中的画法（低分辨率、场景挪用）
            both((r) => (r as unknown as { renderMoving(k: number): void }).renderMoving(w.kmPerUnit));
            check(`${tag} 移动中`);
            both((r) => (r as unknown as { composeKey: string }).composeKey = '');
          }
        }
        // 导出的一块（同停稳的画法，离屏）
        const Z = (16 / mesh.spacing) * 1;
        const frame = { cam: { x: mesh.x[border[0] ?? 0], y: mesh.y[border[0] ?? 0], zoom: Z }, dpr: 1, width: 256, height: 256 };
        const tv = tileView(frame as Parameters<typeof tileView>[0], 0, 0, 128, 16);
        both((r) => r.setFocus(null, null));
        const ta = A.renderTile(w.kmPerUnit, tv, 128, Z, 1);
        const tb = B.renderTile(w.kmPerUnit, tv, 128, Z, 1);
        const td = diff(ta, tb);
        cases++;
        if (td) bad++;
        out.push(`${label} ${mode} 导出的一块: ${td ? `DIFF ${td} bytes` : 'same'}`);
        // 整个星球：等面积与球形投影
        if (mesh.kind === 'sphere') {
          for (const kind of ['equalEarth', 'globe'] as const) {
            for (const z of opts.quick ? [160] : [90, 400]) {
              const c = border[0] ?? 0;
              const lon0 = Math.PI * (mesh.x[c] - 1);
              const lat0 = kind === 'globe' ? Math.PI * (0.5 - mesh.y[c]) : 0;
              both((r) => {
                r.camera = { x: 1, y: 0.5, zoom: z, proj: { kind, lon0, lat0 } };
                r.setFocus(null, null);
                r.render(w.kmPerUnit, { still: true });
              });
              const tag = `${label} ${mode} ${kind} 缩放 ${z}`;
              check(`${tag} 不描`);
              for (const [fa, fb, name] of [
                [{ cell: c, land: true }, null, '描鼠标下的格'],
                [{ cell: border[1] ?? 1, land: true }, { cell: c, land: true }, '换一格、钉住一格'],
                [null, null, '不描'],
              ] as const) {
                both((r) => {
                  r.setFocus(fa, fb);
                  r.render(w.kmPerUnit, { still: true });
                });
                check(`${tag} ${name}`);
              }
            }
          }
          both((r) => (r.camera = { x: 1, y: 0.5, zoom: 100 }));
        }
      }
    }
  } catch (e) {
    out.push(`ERROR ${(e as Error).stack ?? e}`);
    bad++;
  }
  out.push(`描格改变了画面的组：${focusChanged}`);
  out.push(`DONE 共 ${cases} 组，不同 ${bad} 组（${((performance.now() - t0) / 1000).toFixed(0)} 秒）`);
  pre.textContent = out.join('\n');
}

// 计时（--time）：大一些的画布（960 × 640），整张合成（不重画地形层）旧、新交替各 7 次取中位数；新的另看不跳过离边界远的格时
// （ρ 去掉）。SwiftShader 是在 CPU 上跑的，只能看个大概，真正的 GPU 时间在浏览器里用 ?perf 量
function timing(OldR: Ctor, NewR: Ctor) {
  const out: string[] = [];
  const pre = document.getElementById('o')!;
  try {
    const W = 960;
    const H = 640;
    const mk = () => {
      const c = document.createElement('canvas');
      c.style.cssText = `width:${W}px;height:${H}px;display:block`;
      document.body.appendChild(c);
      return c;
    };
    const ca = mk();
    const cb = mk();
    const A = new OldR(ca);
    const B = new NewR(cb);
    const once = (r: AnyRenderer, c: HTMLCanvasElement, km: number) => {
      const gl = c.getContext('webgl2')!;
      (r as unknown as { composeKey: string }).composeKey = '';
      const t = performance.now();
      r.render(km, { still: true });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return performance.now() - t;
    };
    const med = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
    for (const { label, eng } of worlds(opts.plain)) {
      const w = eng.world;
      const { mesh } = w;
      for (const r of [A, B]) r.setMesh(mesh);
      B.prepareNear?.();
      const rho = (B as unknown as { nearRho: Float32Array | null }).nearRho;
      const border = borderCells(w);
      for (const mode of ['terrain', 'provinces', 'country', 'culture'] as ViewMode[]) {
        const st = settings(w, mode, false);
        const layers = cellLayers(w, st.o);
        for (const r of [A, B]) {
          r.setLayers(layers);
          r.flatByGroup = st.flatByGroup;
          r.provinceAlpha = st.provinceAlpha;
          r.countryAlpha = st.countryAlpha;
          r.provinceScale = provinceScale(w.causes.province);
          r.setFocus(null, null);
          r.setHighlight(null);
        }
        B.prepareNear?.();
        for (const z of [4, 12, 32]) {
          for (const r of [A, B]) {
            r.camera = { x: mesh.x[border[0] ?? 0], y: mesh.y[border[0] ?? 0], zoom: z / mesh.spacing };
            r.render(w.kmPerUnit, { still: true });
          }
          const ta: number[] = [];
          const tb: number[] = [];
          const tn: number[] = [];
          for (let k = 0; k < 7; k++) {
            ta.push(once(A, ca, w.kmPerUnit));
            tb.push(once(B, cb, w.kmPerUnit));
            (B as unknown as { nearRho: Float32Array | null }).nearRho = null;
            tn.push(once(B, cb, w.kmPerUnit));
            (B as unknown as { nearRho: Float32Array | null }).nearRho = rho;
          }
          const a = med(ta);
          const b = med(tb);
          const n = med(tn);
          out.push(`${label} ${mode} 一格 ${z} 像素：旧 ${a.toFixed(1)} ms，新 ${b.toFixed(1)} ms（${((b / a) * 100).toFixed(0)}%），新但不跳过离边界远的格 ${n.toFixed(1)} ms（${((n / a) * 100).toFixed(0)}%）`);
          pre.textContent = out.join('\n');
        }
      }
    }
  } catch (e) {
    out.push(`ERROR ${(e as Error).stack ?? e}`);
  }
  out.push('DONE 计时');
  pre.textContent = out.join('\n');
}
