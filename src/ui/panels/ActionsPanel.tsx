import { Boxes, CircleHelp, CopyPlus, FileDown, FilePlus, FolderOpen, ImageDown, Library, PackageOpen, Save } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type WheelPref, download, exportProgress, exportZip, helpOpen, openPanel, prefs, setPrefs, wizardOpen, world } from '../../state';
import { Seg } from '../common';
import { type LabelSize, autoSeam, seamLongitude } from '../../render/export-plan';
import { EE_HALF_W } from '../../render/projection';
import type { World } from '../../../core/world';
import { exportFullMap, snapshotCanvas } from '../map/export';
import { HistoryPanel } from '../panels';
import { openPackLibrary } from '../packs/store';
import { fileNameOf } from '../../maps';
import { beforeLeave, currentMap, exportCurrent, mapStatus, openFile, openMaps, saveMap, saveMapAs } from '../maps/store';

// “世界”：新建、我的地图、保存、打开文件、导出文件；“操作”：导出、历史、上手说明、偏好

export function WorldMenu() {
  const close = () => (openPanel.value = null);
  return (
    <div class="menu">
      <p class="muted small map-status">{mapStatus()}</p>
      <button
        class="menu-row"
        onClick={async () => {
          close();
          if (await beforeLeave()) wizardOpen.value = true;
        }}
      >
        <FilePlus size={18} />
        <span>
          <b>新世界…</b>
          <span class="how">选世界的类型、大小和在星球上的位置，从几张小图里挑一张</span>
        </span>
      </button>
      <button
        class="menu-row"
        onClick={() => {
          close();
          openMaps();
        }}
      >
        <Library size={18} />
        <span>
          <b>我的地图…</b>
          <span class="how">保存在这个浏览器里的世界：打开、改名、导出、删掉</span>
        </span>
      </button>
      <button
        class="menu-row"
        disabled={!world.value}
        onClick={() => {
          close();
          void saveMap();
        }}
      >
        <Save size={18} />
        <span>
          <b>保存</b>
          <span class="how">{currentMap.value ? `存进“我的地图”里的「${currentMap.value.name}」（⌘S）` : '起个名字，存进“我的地图”（⌘S）'}</span>
        </span>
      </button>
      <button
        class="menu-row"
        disabled={!world.value}
        onClick={() => {
          close();
          void saveMapAs();
        }}
      >
        <CopyPlus size={18} />
        <span>
          <b>另存为…</b>
          <span class="how">换个名字存成新的一张，之后改的是新的这一张（⇧⌘S）</span>
        </span>
      </button>
      <label class="menu-row file-button">
        <FolderOpen size={18} />
        <span>
          <b>打开世界文件…</b>
          <span class="how">接着改导出过的世界（.json）；按 ⌘S 可以存进“我的地图”</span>
        </span>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void openFile(f);
            (e.target as HTMLInputElement).value = '';
            close();
          }}
        />
      </label>
      <button class="menu-row" disabled={!world.value} onClick={() => void exportCurrent()}>
        <FileDown size={18} />
        <span>
          <b>导出世界文件（.json）</b>
          <span class="how">所有编辑都在里面，换电脑、发给别人、留备份，之后可以打开继续改</span>
        </span>
      </button>
      <button
        class="menu-row"
        onClick={() => {
          close();
          openPackLibrary();
        }}
      >
        <Boxes size={18} />
        <span>
          <b>资源包…</b>
          <span class="how">装进别人做好的生态、河流和湖泊类型、星球形态，或把这个世界里自己做的导出来</span>
        </span>
      </button>
      <p class="muted small">⌘S 保存到“我的地图”；换电脑或留备份时导出世界文件</p>
    </div>
  );
}

// 整张地图（.png）的宽度与地名字号：面板关上再打开时还是上次选的
const PNG_WIDTHS = [2048, 4096, 8192];
const LABEL_SIZES: [LabelSize, string][] = [
  ['small', '小'],
  ['medium', '中'],
  ['large', '大'],
];
// 整个星球的分界线（图的左右边）：自动放在最宽的海上、以现在的画面为中心，或者按经度自己定
type SeamMode = 'auto' | 'view' | 'lon';
const SEAM_MODES: [SeamMode, string][] = [
  ['auto', '自动'],
  ['view', '画面中心'],
  ['lon', '按经度'],
];
const SEAM_TITLES: Record<SeamMode, string> = {
  auto: '放在最宽的海上：尽量不把陆地切成两半',
  view: '以现在屏幕上的画面为中心，分界线在它的背面',
  lon: '拖滑块定分界线的经度',
};
// 整个星球在等面积、球形投影里看时：按现在的投影导出，还是照旧展开成 2:1（等距圆柱）
type PngProj = 'current' | 'equirect';
const pngChoice: { width: number; labels: LabelSize; seamMode: SeamMode; seamLon: number; proj: PngProj } = { width: 4096, labels: 'medium', seamMode: 'auto', seamLon: 180, proj: 'current' };

// 经度（−180–180，东经为正）→ x（[0, 2)）
const lonToX = (lon: number) => (((lon / 180 + 1) % 2) + 2) % 2;
const lonText = (lon: number) => {
  const a = Math.round(Math.abs(lon));
  return a === 0 ? '0°' : a === 180 ? '180°' : `${lon > 0 ? '东经' : '西经'} ${a}°`;
};

// 现在的画面中心在哪个 x（MapView 把渲染器挂在 window.__map2 上）
function viewCenterX(): number {
  const hook = (window as unknown as { __map2?: { renderer: { camera: { x: number; proj?: { lon0: number } } } } }).__map2;
  if (!hook) return 1;
  // 等面积、球形投影：镜头在投影平面上，画面中心的经度是中央经线（球形是朝着的那一点）
  const p = hook.renderer.camera.proj;
  return p ? 1 + p.lon0 / Math.PI : hook.renderer.camera.x;
}

// 分界线的小预览：整个星球的陆海（每格一个点），按导出的样子从分界线切开，左右两边就是分界线
const STRIP_W = 240;
const STRIP_H = 120;
const landGrids = new WeakMap<Uint8Array, Uint8Array>();
function landGrid(w: World): Uint8Array {
  let g = landGrids.get(w.causes.land);
  if (g) return g;
  g = new Uint8Array(STRIP_W * STRIP_H);
  const { mesh, causes } = w;
  for (let i = 0; i < mesh.n; i++) {
    const x = Math.min(STRIP_W - 1, Math.floor(((mesh.x[i] - 2 * Math.floor(mesh.x[i] / 2)) / 2) * STRIP_W));
    const y = Math.min(STRIP_H - 1, Math.max(0, Math.floor(mesh.y[i] * STRIP_H)));
    if (causes.land[i]) g[y * STRIP_W + x] = 2;
    else if (!g[y * STRIP_W + x]) g[y * STRIP_W + x] = 1;
  }
  landGrids.set(w.causes.land, g);
  return g;
}
function SeamStrip({ w, seamX }: { w: World; seamX: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = landGrid(w);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(STRIP_W, STRIP_H);
    const shift = Math.round((seamX / 2) * STRIP_W);
    for (let y = 0; y < STRIP_H; y++) {
      for (let x = 0; x < STRIP_W; x++) {
        // 按格的点画：没有点落到的像素取左右的
        const sx = (x + shift) % STRIP_W;
        let v = g[y * STRIP_W + sx];
        if (!v) v = g[y * STRIP_W + ((sx + 1) % STRIP_W)] || g[y * STRIP_W + ((sx + STRIP_W - 1) % STRIP_W)];
        const o = 4 * (y * STRIP_W + x);
        const [r, gg, b] = v === 2 ? [176, 168, 120] : [54, 92, 130];
        img.data[o] = r;
        img.data[o + 1] = gg;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [w.causes.land, seamX]);
  return <canvas ref={ref} class="seam-strip" width={STRIP_W} height={STRIP_H} title="导出的图的样子：左右两边就是分界线" />;
}

const WHEEL: [WheelPref, string][] = [
  ['auto', '自动'],
  ['zoom', '缩放'],
  ['pan', '平移'],
];

export function ActionsPanel() {
  const w = world.value;
  const [width, setWidth] = useState(4096);
  const [png, setPng] = useState({ ...pngChoice });
  // 自动的分界线：按陆海算一次（世界的陆海变了才重算）
  const autoX = useMemo(() => (w && w.mesh.kind === 'sphere' ? autoSeam(w.mesh.x, w.causes.land, w.mesh.y) : 0), [w?.mesh, w?.causes.land]);
  if (!w) return null;
  const choosePng = (v: Partial<typeof pngChoice>) => {
    Object.assign(pngChoice, v);
    setPng({ ...pngChoice });
  };
  // 图片文件名用“我的地图”里的名字（没保存的世界叫 map）
  const pngName = (suffix = '') => fileNameOf(currentMap.value?.name ?? 'map').replace(/\.json$/, `${suffix}.png`);
  const savePng = () => {
    const c = snapshotCanvas();
    if (c) c.toBlob((b) => b && download(pngName('（画面）'), b, 'image/png'), 'image/png');
  };
  const sphere = w.mesh.kind === 'sphere';
  // 分界线的 x：自动、画面中心（分界线在画面中心的背面）、按经度
  const seamOf = (mode: SeamMode): number => (mode === 'auto' ? autoX : mode === 'view' ? (((viewCenterX() - 1) % 2) + 2) % 2 : lonToX(png.seamLon));
  const seamX = seamOf(png.seamMode);
  // 现在在等面积、球形投影里看：可以按这个投影导出
  const viewProj = sphere && prefs.value.projection !== 'equirect' ? prefs.value.projection : null;
  const projected = !!viewProj && png.proj === 'current';
  const saveFullPng = async () => {
    // 画面中心按点按钮这一刻的画面
    const b = await exportFullMap({ width: png.width, labels: png.labels, ...(projected ? { projected: true } : sphere ? { seam: seamOf(png.seamMode) } : {}) });
    if (b) download(pngName(), b, 'image/png');
  };
  // 整张图的高：一块地区按长宽比，整个星球是 2:1；等面积约 2.05:1，球形是正方形
  const pngHeight = (s: number) => (projected ? (viewProj === 'globe' ? s : Math.round(s / (2 * EE_HALF_W))) : Math.round((s * w.mesh.height) / w.mesh.width));
  return (
    <>
      <section>
        <h5>导出</h5>
        <div class="row">
          <button
            class="primary"
            disabled={exportProgress.value !== null}
            onClick={async () => {
              const zip = await exportZip({ width, height: Math.round(width / w.settings.aspect), seaLevelGray: 95, maxElevation: 6000 });
              if (zip) download('world-export.zip', zip, 'application/zip');
            }}
          >
            <PackageOpen size={16} /> 游戏文件包（.zip）
          </button>
          <select value={width} onChange={(e) => setWidth(Number((e.target as HTMLSelectElement).value))} title="图片宽度">
            {[1024, 2048, 4096, 5632, 8192].map((s) => (
              <option value={s}>
                {s} × {Math.round(s / w.settings.aspect)}
              </option>
            ))}
          </select>
        </div>
        <p class="muted small">高度图、省份图与 definition.csv、地形、河流、生态、地名表 features.csv，还有世界文件。</p>
        <div class="row">
          <button disabled={exportProgress.value !== null} onClick={() => void saveFullPng()}>
            <ImageDown size={16} /> 整张地图（.png）
          </button>
          <select value={png.width} onChange={(e) => choosePng({ width: Number((e.target as HTMLSelectElement).value) })} title="图片宽度">
            {PNG_WIDTHS.map((s) => (
              <option value={s}>
                {s} × {pngHeight(s)}
              </option>
            ))}
          </select>
        </div>
        <div class="row between">
          <span>地名字号</span>
          <Seg value={png.labels} options={LABEL_SIZES} onChange={(v) => choosePng({ labels: v })} />
        </div>
        {viewProj && (
          <div class="row between">
            <span>投影</span>
            <Seg
              value={png.proj}
              options={[
                ['current', viewProj === 'globe' ? '球形' : '等面积'],
                ['equirect', '等距圆柱'],
              ]}
              titles={{ current: viewProj === 'globe' ? '朝着现在这一面的半球，球外透明' : '整个椭圆，椭圆外透明', equirect: '照旧展开成 2:1 的长方形' }}
              onChange={(v) => choosePng({ proj: v })}
            />
          </div>
        )}
        {sphere && !projected && (
          <>
            <div class="row between">
              <span>分界线</span>
              <Seg
                value={png.seamMode}
                options={SEAM_MODES}
                titles={SEAM_TITLES}
                onChange={(v) => choosePng(v === 'lon' && png.seamMode !== 'lon' ? { seamMode: v, seamLon: Math.round(seamLongitude(seamX)) } : { seamMode: v })}
              />
            </div>
            {png.seamMode === 'lon' && (
              <label class="adj-row">
                <span class="row between">
                  <span>经度</span>
                  <span class="muted">{lonText(png.seamLon)}</span>
                </span>
                <input type="range" min={-180} max={180} step={1} value={png.seamLon} onInput={(e) => choosePng({ seamLon: Number((e.target as HTMLInputElement).value) })} />
              </label>
            )}
            <SeamStrip w={w} seamX={seamX} />
            <p class="muted small">
              星球从分界线（{lonText(seamLongitude(seamX))}）切开展平{png.seamMode === 'auto' ? '：自动放在最宽的海上，尽量不切开陆地' : ''}。小图是导出的样子，左右两边就是分界线。
            </p>
          </>
        )}
        <p class="muted small">
          按现在的画风和图层画出整张{projected ? (viewProj === 'globe' ? '星球朝着现在这一面的半球' : '星球（等面积的椭圆，中央经线与现在相同）') : w.mesh.kind === 'sphere' ? '星球（经度 360° 展开成 2:1）' : '地图'}，不管镜头在哪；不带工具的高亮和预览。地名、河按整张图排，字号“大”时标出来的地名少一些。图越大画得越久。
        </p>
        <button onClick={savePng}>
          <ImageDown size={16} /> 当前画面（.png）
        </button>
        <p class="muted small">存的是屏幕上现在看到的地图（含地名）。</p>
      </section>
      <section>
        <h5>历史</h5>
        <div class="history-box">
          <HistoryPanel />
        </div>
      </section>
      <section>
        <h5>偏好</h5>
        <div class="row between">
          <span>滚轮 / 双指滑动</span>
          <Seg value={prefs.value.wheel} options={WHEEL} onChange={(v) => setPrefs({ wheel: v })} />
        </div>
        <p class="muted small">“自动”：鼠标滚轮缩放，触控板双指滑动平移、捏合缩放。分辨不准时改成固定的“缩放”或“平移”。</p>
      </section>
      <button
        onClick={() => {
          helpOpen.value = true;
          openPanel.value = null;
        }}
      >
        <CircleHelp size={16} /> 上手说明
      </button>
    </>
  );
}
