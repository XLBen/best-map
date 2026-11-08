// 珊瑚礁（第八十六轮）：暖、浅、清的海里自己长出来（以前只有放的珊瑚岛、小礁）。每个海格一个 0–1 的强度：
//   · 暖：两个半年里冷的那一季的海面气温从 WARM0 到 WARM1 °C 渐满（真实的礁要最冷月 18 °C 以上）；
//   · 浅：水深 DEEP0 m 以内满，到 DEEP1 m 没有（大陆架、岛架上）；
//   · 清：离大河口远。入海的河的流量（m³/s）记在河口外的那一格，往外三圈每圈减半，从 MUDDY0 到 MUDDY1 渐渐没有；
//   · 成片：按公里定尺度的噪声，只取一部分（礁是一片一片的，不是整条大陆架都是）。
// 只是画法：地形着色器读岩性层的“白沙”（colors-human.ts 的 lithLayer：海底青绿、浅处一圈白浪），与放的珊瑚岛同一套画法。
// 不改海陆、水文、生态
import type { Mesh } from './mesh';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import type { World } from './world';

export const REEF = {
  WARM0: 18,
  WARM1: 21,
  DEEP0: 50,
  DEEP1: 130,
  MUDDY0: 400,
  MUDDY1: 3000,
  RINGS: 3,
  // 成片的噪声：波长约 PATCH_KM，超过 PATCH_T 的才有（过渡 PATCH_W）
  PATCH_KM: 350,
  PATCH_T: -0.05,
  PATCH_W: 0.2,
};

const ramp = (t: number, a: number, b: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

// 成片的噪声（按网格、种子、比例尺缓存）
const patchCache = new WeakMap<Mesh, { key: string; v: Float32Array }>();
function patches(world: World): Float32Array {
  const { mesh } = world;
  const key = `${world.settings.seed}|${world.kmPerUnit}`;
  const hit = patchCache.get(mesh);
  if (hit && hit.key === key) return hit.v;
  const n = mesh.n;
  const v = new Float32Array(n);
  const f = 1 / REEF.PATCH_KM;
  if (mesh.kind === 'sphere') {
    const R = world.kmPerUnit / Math.PI;
    const g = gradientNoise3(mixSeed(world.settings.seed, 8601));
    for (let i = 0; i < n; i++) v[i] = fbm3(g, mesh.p[3 * i] * R, mesh.p[3 * i + 1] * R, mesh.p[3 * i + 2] * R, f, 2);
  } else {
    const km = world.kmPerUnit;
    const g = gradientNoise(mixSeed(world.settings.seed, 8601));
    for (let i = 0; i < n; i++) v[i] = fbm(g, mesh.x[i] * km, mesh.y[i] * km, f, 2);
  }
  patchCache.set(mesh, { key, v });
  return v;
}

// 每个海格的珊瑚礁强度（陆格、湖是 0）
export function reefStrength(world: World): Float32Array {
  const { mesh, causes, derived: d } = world;
  const n = mesh.n;
  const land = causes.land;
  const out = new Float32Array(n);
  // 先只看暖、浅：大多数世界里这样的海格很少，没有时整段跳过
  let any = false;
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    const warm = ramp(Math.min(d.tS[i], d.tW[i]), REEF.WARM0, REEF.WARM1);
    if (warm <= 0) continue;
    const shallow = 1 - ramp(-d.elevation[i], REEF.DEEP0, REEF.DEEP1);
    if (shallow <= 0) continue;
    out[i] = warm * shallow;
    any = true;
  }
  if (!any) return out;
  // 河口的浑水：入海的流量记在河口外的海格，往外每圈减半
  let mud = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = d.receiver[i];
    if (land[i] && j >= 0 && !land[j]) mud[j] += d.discharge[i];
  }
  for (let r = 0; r < REEF.RINGS; r++) {
    const next = mud.slice();
    for (let i = 0; i < n; i++) {
      if (land[i] || mud[i] <= 0) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (!land[j] && next[j] < mud[i] * 0.5) next[j] = mud[i] * 0.5;
      }
    }
    mud = next;
  }
  const patch = patches(world);
  for (let i = 0; i < n; i++) {
    if (out[i] <= 0) continue;
    out[i] *= (1 - ramp(mud[i], REEF.MUDDY0, REEF.MUDDY1)) * ramp(patch[i], REEF.PATCH_T, REEF.PATCH_T + REEF.PATCH_W);
  }
  return out;
}
