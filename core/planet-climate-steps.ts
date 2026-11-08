// 星球气候的各小步（第八十三轮从 core/planet-climate.ts 原样搬出）：气温、水汽的扫掠、海风、背风与洋流、季风、海面的饱和
import { type SphereFlow, PLANET_SWEEPS } from './sphere-flow';
import { type World, worldLatitude } from './world';
import { clamp, smoothstep } from './rng';
import { saturation } from './climate';
import type { SphereMesh } from './mesh';

// ---------- 整个星球的气候 ----------

// 输运图里输运要用的部分（入流表，见 SphereFlow）
export type Inflow = Pick<SphereFlow, 'order' | 'koff' | 'src' | 'w' | 'den'>;

// 两季的温度（没有洋流）
export function sphereTemps(n: number, land: Uint8Array, elevation: Float32Array, lapseRate: number, tOff: Float32Array, t0S: Float64Array, t0W: Float64Array, tS: Float32Array, tW: Float32Array) {
  for (let i = 0; i < n; i++) {
    const lapse = land[i] ? (lapseRate * Math.max(0, elevation[i])) / 1000 : 0;
    const off = tOff[i];
    tS[i] = t0S[i] - lapse + off;
    tW[i] = t0W[i] - lapse + off;
  }
}

// 两季的温度（加上洋流带来的增减）：与上面相同，再加 add（先写进 Float32 再加，与以前一样）
export function sphereTempsAdd(n: number, land: Uint8Array, elevation: Float32Array, lapseRate: number, tOff: Float32Array, t0S: Float64Array, t0W: Float64Array, addS: Float64Array, addW: Float64Array, tS: Float32Array, tW: Float32Array) {
  for (let i = 0; i < n; i++) {
    const lapse = land[i] ? (lapseRate * Math.max(0, elevation[i])) / 1000 : 0;
    const off = tOff[i];
    tS[i] = t0S[i] - lapse + off;
    tW[i] = t0W[i] - lapse + off;
    tS[i] += addS[i];
    tW[i] += addW[i];
  }
}

// 水汽的初值：陆上为饱和量的一半，海上为海面饱和量
export function moistInit(n: number, land: Uint8Array, lim: Float64Array, moist: Float64Array) {
  for (let i = 0; i < n; i++) moist[i] = land[i] ? 0.5 * lim[i] : lim[i];
}

// 一季的降水
export function precipOf(n: number, removed: Float64Array, off: Float32Array, P: Float32Array) {
  for (let i = 0; i < n; i++) P[i] = removed[i] * 1.7e6 * Math.exp(off[i]);
}

// 第三十五轮（提速）：sphereTerrain 里剩下的几段逐格循环放进小函数（原样照搬，结果逐值相同）。
// 每格的纬度（与逐格调 worldLatitude 相同）
export function latitudesOf(world: World, lat: Float64Array) {
  const y = world.mesh.y;
  for (let i = 0; i < lat.length; i++) lat[i] = worldLatitude(world, y[i]);
}

// 陆地的高程（海与负的为 0）
export function landHeights(n: number, land: Uint8Array, elevation: Float32Array, hPos: Float64Array) {
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? Math.max(0, elevation[i]) : 0;
}

// 梯度换成每 km
export function perKm(n: number, hx: Float64Array, hy: Float64Array, kmPerUnit: number) {
  for (let i = 0; i < n; i++) {
    hx[i] = hx[i] / kmPerUnit;
    hy[i] = hy[i] / kmPerUnit;
  }
}

// 偏转后的风 = (偏转前 + 变化量) × 极地衰减（变化量为 0 的格不动）
export function addDeltaTaper(n: number, u: Float64Array, v: Float64Array, du: Float64Array, dv: Float64Array, taper: Float64Array, wx: Float32Array, wy: Float32Array) {
  for (let i = 0; i < n; i++) {
    if (du[i] === 0 && dv[i] === 0) continue;
    wx[i] = (u[i] + du[i]) * taper[i];
    wy[i] = (v[i] + dv[i]) * taper[i];
  }
}

// marine += 0.5 · clamp(m, 0, 1)
export function addHalfClamped(n: number, marine: Float64Array, m: Float64Array) {
  for (let i = 0; i < n; i++) marine[i] += 0.5 * clamp(m[i], 0, 1);
}

// 大陆度（海上为 0）
export function continentalityOf(n: number, land: Uint8Array, marine: Float64Array, out: Float32Array) {
  for (let i = 0; i < n; i++) out[i] = land[i] ? 1 - marine[i] : 0;
}

// 海温的偏离随风上岸的衰减（陆上）
export function sstDecayOf(n: number, land: Uint8Array, spacingKm: Float64Array, elevation: Float32Array, sstDecay: Float64Array) {
  for (let i = 0; i < n; i++) if (land[i]) sstDecay[i] = Math.exp((-spacingKm[i] * (1 + Math.max(0, elevation[i]) / 800)) / 1200);
}

// 海温的偏离（陆上是两季带上岸的平均的八成）
export function sstAnomOf(n: number, land: Uint8Array, a0: Float64Array, a1: Float64Array, dSST: Float64Array, out: Float32Array) {
  for (let i = 0; i < n; i++) out[i] = land[i] ? (0.8 * (a0[i] + a1[i])) / 2 : dSST[i];
}

// 两季的温度里只取决于地形的部分
export function baseTemps(n: number, land: Uint8Array, tAnnOf: Float64Array, kS: Float64Array, kW: Float64Array, cont: Float32Array, t0S: Float64Array, t0W: Float64Array) {
  for (let i = 0; i < n; i++) {
    const tAnn = tAnnOf[i];
    const amp = land[i] ? 0.3 + 0.7 * cont[i] : 0.3;
    t0S[i] = tAnn + kS[i] * amp;
    t0W[i] = tAnn + kW[i] * amp;
  }
}

// 洋流带来的增减：海上直接改变海温，陆上是风带来的海洋影响
export function currentAdds(n: number, land: Uint8Array, a0: Float64Array, a1: Float64Array, dSST: Float64Array, addS: Float64Array, addW: Float64Array) {
  for (let i = 0; i < n; i++) {
    if (land[i]) {
      addS[i] = 0.8 * a0[i];
      addW[i] = 0.8 * a1[i];
    } else {
      addS[i] = dSST[i];
      addW[i] = dSST[i];
    }
  }
}

// 第三十二轮（提速）：computeClimateSphere 里两段逐格的循环拆成小函数（很快就被编译优化），原样照搬，结果逐值相同。
// 每格降落的比例、饱和量、蒸散回补的比例
export function rainSetup(
  n: number,
  land: Uint8Array,
  T: Float32Array,
  rain: Float64Array,
  lee: Float64Array,
  cur: Float64Array | null,
  satSea: Float64Array,
  dKm: Float64Array,
  humidity: number,
  fall: Float64Array,
  lim: Float64Array,
  evap: Float64Array,
) {
  for (let i = 0; i < n; i++) {
    const warmth = 0.45 + 0.55 * smoothstep(-10, 25, T[i]);
    // 不在背风处 lee 为 1，乘上去数值不变
    let r = ((rain[i] * warmth) / 1800) * lee[i];
    if (cur) r *= cur[i];
    fall[i] = 1 - Math.exp(-r * dKm[i]);
    if (land[i]) {
      lim[i] = humidity * saturation(T[i]) * 1.1;
      evap[i] = smoothstep(0, 25, T[i]);
    } else lim[i] = humidity * satSea[i];
  }
}

// 水汽沿风输运固定遍数，removed：每格降下的（除以格距）
export function moistureSweeps(
  f: Inflow,
  land: Uint8Array,
  fall: Float64Array,
  lim: Float64Array,
  evap: Float64Array,
  e150: Float64Array,
  e900: Float64Array,
  dKm: Float64Array,
  moist: Float64Array,
  removed: Float64Array,
) {
  const n = land.length;
  const { order, koff, src, w, den } = f;
  for (let s = 0; s < PLANET_SWEEPS.wind; s++) {
    for (let k = 0; k < n; k++) {
      const i = order[k];
      let num = 0;
      for (let q = koff[k]; q < koff[k + 1]; q++) num += moist[src[q]] * w[q];
      // 辐散中心是下沉气流：相对湿度约一半
      let m = den[k] > 1e-9 ? num / den[k] : land[i] ? (0.5 * lim[i]) / 1.1 : 0.5 * lim[i];
      let p = m * fall[i];
      m -= p;
      if (land[i]) {
        const cap = lim[i];
        if (m > cap) {
          const excess = (m - cap) * e150[i];
          p += excess;
          m -= excess;
        }
        m += p * 0.6 * evap[i];
      } else {
        const sat = lim[i];
        if (m > sat * 1.1) {
          const excess = (m - sat * 1.1) * e150[i];
          p += excess;
          m -= excess;
        }
        m += (sat - m) * e900[i];
      }
      removed[i] = p / dKm[i];
      moist[i] = Math.max(0, m);
    }
  }
}

// 示踪量的稳态输运（与按格回调的通用写法逐值相同）：沿拓扑序扫描固定遍数，每格取上风各格的加权平均再乘上本格的衰减；
// 海上格的值一直是初值，只扫陆地格。没有任何上风来源的陆地格取 0
export function landSweeps(f: Inflow, land: Uint8Array, init: Float64Array, decay: Float64Array): Float64Array {
  const n = land.length;
  const { order, koff, src, w, den } = f;
  const out = Float64Array.from(init);
  for (let s = 0; s < PLANET_SWEEPS.wind; s++) {
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (!land[i]) continue;
      let num = 0;
      for (let q = koff[k]; q < koff[k + 1]; q++) num += out[src[q]] * w[q];
      out[i] = (den[k] > 1e-9 ? num / den[k] : 0) * decay[i];
    }
  }
  return out;
}

// 海风（sphereTerrain 里拆出来的一遍，原样照搬）：沿岸 ring 以内的陆格与邻格平均
export function breezePass(mesh: SphereMesh, land: Uint8Array, ring: Int32Array, A: Float64Array) {
  const n = mesh.n;
  const next = Float64Array.from(A);
  for (let i = 0; i < n; i++) {
    if (!land[i] || ring[i] < 0) continue;
    let s = 0;
    let m = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      s += A[mesh.adj[e]];
      m++;
    }
    next[i] = 0.5 * A[i] + (0.5 * s) / Math.max(1, m);
  }
  A.set(next);
}

// 一季的背风（不在背风处为 1）与洋流对降水的影响（sphereTerrain 里拆出来的，原样照搬；没有洋流时 cur 为 null）
export function leeAndCurrents(
  n: number,
  land: Uint8Array,
  wx: Float32Array,
  wy: Float32Array,
  hx: Float64Array,
  hy: Float64Array,
  lee: Float64Array,
  cur: Float64Array | null,
  dSST: Float64Array | null,
  anomaly: Float64Array | null,
) {
  for (let i = 0; i < n; i++) {
    lee[i] = 1;
    if (land[i]) {
      const wm = Math.hypot(wx[i], wy[i]) || 1;
      const up = (wx[i] * hx[i] + wy[i] * hy[i]) / wm;
      if (up < 0) lee[i] = Math.exp(up / 1.5);
    }
    // 冷水海岸空气稳定（多雾少雨），暖流上空对流更强
    if (cur && dSST && anomaly) cur[i] = clamp(1 + 0.06 * (land[i] ? anomaly[i] : dSST[i]), 0.5, 1.25);
  }
}

// 一季偏转前的风（sphereLand 里拆出来的，原样照搬）：背景风加季风、限幅、乘极地衰减；rx、ry：没乘衰减的（山挡风开着时）
export function seasonWinds(
  n: number,
  u0: Float64Array,
  v0: Float64Array,
  kf: Float64Array,
  taper: Float64Array,
  lfE: Float64Array,
  lfS: Float64Array,
  wx: Float32Array,
  wy: Float32Array,
  rx: Float64Array | null,
  ry: Float64Array | null,
) {
  for (let i = 0; i < n; i++) {
    let u = u0[i];
    let v = v0[i];
    const k = kf[i];
    u += k * lfE[i];
    v += k * lfS[i];
    const mag = Math.hypot(u, v);
    const lim = 1.3;
    if (mag > lim) {
      u *= lim / mag;
      v *= lim / mag;
    }
    const t = taper[i];
    wx[i] = u * t;
    wy[i] = v * t;
    if (rx && ry) {
      rx[i] = u;
      ry[i] = v;
    }
  }
}

// 两季海面温度的饱和水汽量（sphereLand 里拆出来的，原样照搬）
export function seaSaturation(n: number, land: Uint8Array, tAnn: Float64Array, kS: Float64Array, kW: Float64Array, sst: Float64Array | null, outS: Float64Array, outW: Float64Array) {
  for (let i = 0; i < n; i++) {
    let oS = tAnn[i] + kS[i] * 0.3;
    let oW = tAnn[i] + kW[i] * 0.3;
    if (sst && !land[i]) {
      oS += sst[i];
      oW += sst[i];
    }
    outS[i] = saturation(oS);
    outW[i] = saturation(oW);
  }
}
