// 洋流的栅格上的几个小算子（第四十六轮从 ocean-plane.ts 原样搬来）：只看像素，不碰网格与气候

// 每行到东、西两边海岸的距离（km）；图边：图外是海时外面还有 ext km 的海，否则图边就是海岸
export function rowDistances(steer: Uint8Array, cols: number, rows: number, pwKm: number, ext: number, dE: Float64Array, dW: Float64Array) {
  for (let r = 0; r < rows; r++) {
    let d = ext;
    for (let c = cols - 1; c >= 0; c--) {
      const k = r * cols + c;
      d = steer[k] ? 0 : d + pwKm;
      dE[k] = d;
    }
    d = ext;
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      d = steer[k] ? 0 : d + pwKm;
      dW[k] = d;
    }
  }
}

// 每个海格的海流、偏离：四个像素里只用海上的，按双线性的权重重新归一；四个都是陆地时为 0
// 挡海流的陆地：面积够大（像素数 ≥ minPx）的陆块，再填掉一像素宽的海峡（四周的像素都挨着陆地的海像素）
export function steerPx(landPx: Uint8Array, cols: number, rows: number, minPx: number): Uint8Array {
  const N = cols * rows;
  const steer = new Uint8Array(N);
  const seen = new Uint8Array(N);
  const q = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!landPx[s] || seen[s]) continue;
    let len = 0;
    q[len++] = s;
    seen[s] = 1;
    for (let h = 0; h < len; h++) {
      const k = q[h];
      const c = k % cols;
      const r = (k - c) / cols;
      for (let t = 0; t < 4; t++) {
        const j = t === 0 ? (c > 0 ? k - 1 : -1) : t === 1 ? (c < cols - 1 ? k + 1 : -1) : t === 2 ? (r > 0 ? k - cols : -1) : r < rows - 1 ? k + cols : -1;
        if (j >= 0 && landPx[j] && !seen[j]) {
          seen[j] = 1;
          q[len++] = j;
        }
      }
    }
    if (len >= minPx) for (let h = 0; h < len; h++) steer[q[h]] = 1;
  }
  const dil = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const c = k % cols;
    const r = (k - c) / cols;
    dil[k] = steer[k] || (c > 0 && steer[k - 1]) || (c < cols - 1 && steer[k + 1]) || (r > 0 && steer[k - cols]) || (r < rows - 1 && steer[k + cols]) ? 1 : 0;
  }
  const out = steer.slice();
  for (let k = 0; k < N; k++) {
    if (steer[k] || !dil[k]) continue;
    const c = k % cols;
    const r = (k - c) / cols;
    if ((c === 0 || dil[k - 1]) && (c === cols - 1 || dil[k + 1]) && (r === 0 || dil[k - cols]) && (r === rows - 1 || dil[k + cols])) out[k] = 1;
  }
  return out;
}

// 南北方向 ±k 行平均
export function smoothRows(a: Float64Array, cols: number, rows: number, k: number) {
  const tmp = new Float64Array(a.length);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      let s = 0;
      let m = 0;
      for (let d = -k; d <= k; d++) {
        const rr = r + d;
        if (rr < 0 || rr >= rows) continue;
        s += a[rr * cols + c];
        m++;
      }
      tmp[r * cols + c] = s / m;
    }
  }
  a.set(tmp);
}

// 海上与四邻平均一遍（挡流的陆地不动，作为 0 参与平均）
export function smoothSea(a: Float64Array, steer: Uint8Array, cols: number, rows: number) {
  const next = Float64Array.from(a);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (steer[k]) continue;
      let s = a[k];
      let m = 1;
      if (c > 0) (s += a[k - 1]), m++;
      if (c < cols - 1) (s += a[k + 1]), m++;
      if (r > 0) (s += a[k - cols]), m++;
      if (r < rows - 1) (s += a[k + cols]), m++;
      next[k] = s / m;
    }
  }
  a.set(next);
}

// 到挡流陆地的距离（km，两遍的倒角距离：横、竖、斜各按像素的宽高算）
export function chamfer(seed: Uint8Array, cols: number, rows: number, pwKm: number, phKm: number): Float64Array {
  const N = cols * rows;
  const d = new Float64Array(N);
  for (let k = 0; k < N; k++) d[k] = seed[k] ? 0 : Infinity;
  const dg = Math.hypot(pwKm, phKm);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      let v = d[k];
      if (c > 0) v = Math.min(v, d[k - 1] + pwKm);
      if (r > 0) {
        v = Math.min(v, d[k - cols] + phKm);
        if (c > 0) v = Math.min(v, d[k - cols - 1] + dg);
        if (c < cols - 1) v = Math.min(v, d[k - cols + 1] + dg);
      }
      d[k] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const k = r * cols + c;
      let v = d[k];
      if (c < cols - 1) v = Math.min(v, d[k + 1] + pwKm);
      if (r < rows - 1) {
        v = Math.min(v, d[k + cols] + phKm);
        if (c < cols - 1) v = Math.min(v, d[k + cols + 1] + dg);
        if (c > 0) v = Math.min(v, d[k + cols - 1] + dg);
      }
      d[k] = v;
    }
  }
  return d;
}
