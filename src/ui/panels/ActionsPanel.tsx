import { Archive, Boxes, CircleHelp, CopyPlus, EyeOff, FileDown, FilePlus, FolderOpen, HardDriveDownload, History, ImageDown, Library, PackageOpen, Save } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  type WheelPref,
  currentSeries,
  download,
  exportPartFiles,
  exportProgress,
  exportZip,
  fileStatus,
  fileSupported,
  helpOpen,
  openPanel,
  prefs,
  refreshVersions,
  saveProblem,
  setPrefs,
  uiHidden,
  wizardOpen,
  world,
} from '../../state';
import { Seg } from '../common';
import { Slider, linear } from '../components/Slider';
import { type LabelSize, autoSeam, seamLongitude } from '../../render/export-plan';
import { EE_HALF_W } from '../../render/projection';
import type { World } from '../../../core/world';
import { exportFullMap, snapshotCanvas } from '../map/export';
import { HistoryPanel } from '../panels';
import { BACKUP_TEXT, FILE_TEXT, HELP_KEY_TIP, LIBRARY_NOTE, SAVE_TEXT, SIMPLE_TEXT, TOUCH_TEXT, VERSION_TEXT } from '../copy';
import { fullUi, setFullUi } from '../ui-prefs';
import { fingerPans, penPressure, penSeen, setFingerPans, setPenPressure, touchUi } from '../touch-ui';
import { fileLine, pickFile, reloadSaved, resumeFileHere, saveNote, stopFileHere, takeOverHere } from '../shell/save-note';
import { OfflineLine } from '../shell/UpdateBanner';
import { openLibrary } from '../packs/panel-store';
import { fileNameOf } from '../../maps';
import { beforeLeave, currentMap, exportCurrent, mapStatus, openFile, openMaps, saveMap, saveMapAs } from '../maps/store';
import { backups, openBackups } from '../maps/backups';
import { openVersions, versionCount, versions } from '../maps/versions';
import { exportPartRows, hasAnySettle } from '../domain/settlements';
import { Toggle } from '../components/Toggle';
import { worldMapStyle } from '../../../core/map-style';
import { DECOR_KEYS, DECOR_LABELS, type DecorOptions, defaultDecor } from '../../render/export-decor';

// “世界”：新建、我的地图、保存、打开文件、资源包、导出（世界文件、游戏文件包、图片都在这里）；“更多”：历史、偏好、上手说明

export function WorldMenu() {
  const close = () => (openPanel.value = null);
  // 第九十五轮：打开菜单时读一次有几份以前的版本
  useEffect(() => void refreshVersions(), []);
  const kept = versionCount(versions.value, currentSeries.value);
  const canFile = fileSupported();
  const file = fileStatus.value;
  return (
    <div class="menu">
      <SaveProblemLine />
      <p class="hint map-status">{mapStatus()}</p>
      <FileStatusLine />
      <button
        class="item"
        onClick={async () => {
          close();
          if (await beforeLeave()) wizardOpen.value = true;
        }}
      >
        <FilePlus />
        <span class="grow item-text">
          <b>新建世界…</b>
          <span class="hint">选类型、大小和位置</span>
        </span>
      </button>
      <button
        class="item"
        onClick={() => {
          close();
          openMaps();
        }}
      >
        <Library />
        <span class="grow item-text">
          <b>我的地图…</b>
          <span class="hint">存在这个浏览器里的世界</span>
        </span>
      </button>
      <button
        class="item"
        disabled={!world.value}
        onClick={() => {
          close();
          void saveMap();
        }}
      >
        <Save />
        <span class="grow item-text">
          <b>保存</b>
          <span class="hint">{currentMap.value ? `存进“${currentMap.value.name}”（⌘S）` : '起名存进“我的地图”（⌘S）'}</span>
        </span>
      </button>
      <button
        class="item"
        disabled={!world.value}
        onClick={() => {
          close();
          void saveMapAs();
        }}
      >
        <CopyPlus />
        <span class="grow item-text">
          <b>另存为…</b>
          <span class="hint">存成新的一张（⇧⌘S）</span>
        </span>
      </button>
      <label class="item">
        <FolderOpen />
        <span class="grow item-text">
          <b>打开世界文件…</b>
          <span class="hint">打开导出过的世界（.json）</span>
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
      {/* 第九十五轮：自动留的以前的版本。没有时灰着，写为什么 */}
      <button
        class="item"
        disabled={kept === 0}
        onClick={() => {
          close();
          openVersions();
        }}
      >
        <History />
        <span class="grow item-text">
          <b>{VERSION_TEXT.menu}</b>
          <span class="hint">{kept > 0 ? VERSION_TEXT.menuHint(kept) : VERSION_TEXT.menuNone}</span>
        </span>
      </button>
      {/* 第九十五轮：选一个电脑上的文件，以后保存时也写进它。浏览器不支持时灰着，写怎么办 */}
      <button
        class="item"
        disabled={!world.value || !canFile}
        onClick={() => {
          close();
          void pickFile();
        }}
      >
        <HardDriveDownload />
        <span class="grow item-text">
          <b>{file.mode === 'off' ? FILE_TEXT.menu : FILE_TEXT.menuAgain}</b>
          <span class="hint">{canFile ? FILE_TEXT.menuHint : FILE_TEXT.unsupported}</span>
        </span>
      </button>
      {/* 第九十一轮：这一版打不开的自动保存留着时才有这一行 */}
      {(backups.value?.length ?? 0) > 0 && (
        <button
          class="item"
          onClick={() => {
            close();
            openBackups();
          }}
        >
          <Archive />
          <span class="grow item-text">
            <b>{BACKUP_TEXT.menu}</b>
            <span class="hint">{BACKUP_TEXT.menuHint(backups.value!.length)}</span>
          </span>
        </button>
      )}
      <button
        class="item"
        onClick={() => {
          close();
          openLibrary();
        }}
      >
        <Boxes />
        <span class="grow item-text">
          <b>资源库…</b>
          <span class="hint">{LIBRARY_NOTE}</span>
        </span>
      </button>
      <ExportSection />
    </div>
  );
}

// 第九十四轮：自动保存没存成时“世界”菜单的第一行——原因、“导出文件”（这个世界开在另一个页面里时还有“在这里接着做”）。
// 第九十五轮：这个页面里的是旧的——主要的是“重新载入”；电脑上的文件没写成——“接着存到…”或“换一个文件…”
function SaveProblemLine() {
  const file = fileStatus.value;
  const n = saveNote(saveProblem.value, file);
  if (!n) return null;
  const main = n.reload || n.file !== null;
  return (
    <div class="save-problem">
      <span>{n.line}</span>
      <span class="row">
        {n.take && (
          <button class="small" onClick={() => void takeOverHere()} title={SAVE_TEXT.takeOverTip}>
            {SAVE_TEXT.takeOver}
          </button>
        )}
        <button class={`small ${main ? '' : 'primary'}`} onClick={() => void exportCurrent()} title={SAVE_TEXT.exportTip}>
          <FileDown /> {SAVE_TEXT.export}
        </button>
        {n.reload && (
          <button class="small primary" onClick={() => void reloadSaved()} title={SAVE_TEXT.reloadTip}>
            {SAVE_TEXT.reload}
          </button>
        )}
        {n.file === 'resume' && file.name && (
          <button class="small primary" onClick={() => void resumeFileHere()} title={FILE_TEXT.resumeTip}>
            {FILE_TEXT.resume(file.name)}
          </button>
        )}
        {n.file === 'pick' && (
          <button
            class="small primary"
            onClick={() => {
              openPanel.value = null;
              void pickFile();
            }}
          >
            {FILE_TEXT.menuAgain}
          </button>
        )}
      </span>
    </div>
  );
}

// 第九十五轮：这张地图也存在电脑上的一个文件里时的状态一行——“也存在电脑上：xxx.json · 刚刚”，能“不再存到这个文件”；
// 这次打开页面还没重新给权限时写“没在写文件：xxx.json”，带“接着存到 xxx.json”
function FileStatusLine() {
  const s = fileStatus.value;
  const line = fileLine(s, Date.now());
  if (!line || !s.name) return null;
  return (
    <div class={`file-line ${line.paused ? 'paused' : ''}`}>
      <span class="hint ellipsis" title={line.text}>
        {line.text}
      </span>
      <span class="row">
        {line.paused && (
          <button class="small primary" onClick={() => void resumeFileHere()} title={FILE_TEXT.resumeTip}>
            {FILE_TEXT.resume(s.name)}
          </button>
        )}
        <button class="small" onClick={() => void stopFileHere()} title={FILE_TEXT.stopTip}>
          {FILE_TEXT.stop}
        </button>
      </span>
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
  auto: '放在最宽的海上，尽量不切开陆地',
  view: '以当前画面为中心',
  lon: '按经度放分界线',
};
// 整个星球在等面积、球形投影里看时：按现在的投影导出，还是照旧展开成 2:1（等距圆柱）
type PngProj = 'current' | 'equirect';
const pngChoice: { width: number; labels: LabelSize; seamMode: SeamMode; seamLon: number; proj: PngProj } = { width: 4096, labels: 'medium', seamMode: 'auto', seamLon: 180, proj: 'current' };

// 整张地图的装饰（第八十七轮）：罗盘、标题、边框、图例。按画风记（手绘默认全开，别的默认全关）；改过的这个面板记着
const decorChoice = new Map<string, DecorOptions>();
const DECOR_TITLES: Record<keyof DecorOptions, string> = { frame: '四周一道双线的边框', compass: '右上角的罗盘', title: '上面写世界的名字', legend: '右下角：地图模式的颜色与符号' };

// 分界线的经度滑块（−180–180，每格 1°）
const LON = linear(-180, 180, 1);

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
  return <canvas ref={ref} class="seam-strip" width={STRIP_W} height={STRIP_H} title="导出的样子，左右两边是分界线" />;
}

const WHEEL: [WheelPref, string][] = [
  ['auto', '自动'],
  ['zoom', '缩放'],
  ['pan', '平移'],
];

// 单独导出（第二十四轮）：游戏文件包里的一项（城市表、道路、档案全文……），点一下只下载这一项的文件。图的宽度跟着游戏文件包选的
const PART_TYPES: Record<string, string> = { csv: 'text/csv', geojson: 'application/geo+json', bmp: 'image/bmp', md: 'text/markdown', json: 'application/json', zip: 'application/zip' };
function PartList({ w, width }: { w: World; width: number }) {
  const rows = exportPartRows(w).filter((r) => r.available);
  if (!rows.length) return null;
  return (
    <details class="part-box">
      <summary>单独导出</summary>
      <div class="list part-list">
        {rows.map((r) => (
          <button
            class="item"
            disabled={exportProgress.value !== null}
            title={r.image ? `宽 ${width}` : undefined}
            onClick={async () => {
              const files = await exportPartFiles(r.id, width);
              for (const [name, data] of Object.entries(files ?? {})) download(name, data, PART_TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream');
            }}
          >
            <FileDown />
            <span class="grow item-text">
              <span>{r.label}</span>
              <span class="hint">{r.files.join('、')}</span>
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}

// 导出：世界文件、游戏文件包、整张地图、当前画面
function ExportSection() {
  const w = world.value;
  const [width, setWidth] = useState(4096);
  const [png, setPng] = useState({ ...pngChoice });
  const [, setDecorTick] = useState(0);
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
  const style = worldMapStyle(w.small);
  const decor = decorChoice.get(style.id) ?? defaultDecor(style);
  const setDecor = (k: keyof DecorOptions, on: boolean) => {
    decorChoice.set(style.id, { ...decor, [k]: on });
    setDecorTick((t) => t + 1);
  };
  const saveFullPng = async () => {
    // 画面中心按点按钮这一刻的画面
    const title = currentMap.value?.name ?? '';
    const b = await exportFullMap({ width: png.width, labels: png.labels, decor, title, ...(projected ? { projected: true } : sphere ? { seam: seamOf(png.seamMode) } : {}) });
    if (b) download(pngName(), b, 'image/png');
  };
  // 整张图的高：一块地区按长宽比，整个星球是 2:1；等面积约 2.05:1，球形是正方形
  const pngHeight = (s: number) => (projected ? (viewProj === 'globe' ? s : Math.round(s / (2 * EE_HALF_W))) : Math.round((s * w.mesh.height) / w.mesh.width));
  return (
    <section>
      <h5>导出</h5>
      <button class="item" disabled={!world.value} onClick={() => void exportCurrent()}>
        <FileDown />
        <span class="grow item-text">
          <b>世界文件（.json）</b>
          <span class="hint">含全部编辑，可打开继续改</span>
        </span>
      </button>
      <div class="export-body">
        <div class="row">
          <button
            class="primary"
            disabled={exportProgress.value !== null}
            onClick={async () => {
              const zip = await exportZip({ width, height: Math.round(width / w.settings.aspect), seaLevelGray: 95, maxElevation: 6000 });
              if (zip) download('world-export.zip', zip, 'application/zip');
            }}
          >
            <PackageOpen /> 游戏文件包（.zip）
          </button>
          <select value={width} onChange={(e) => setWidth(Number((e.target as HTMLSelectElement).value))} title="图片宽度">
            {[1024, 2048, 4096, 5632, 8192].map((s) => (
              <option value={s}>
                {s} × {Math.round(s / w.settings.aspect)}
              </option>
            ))}
          </select>
        </div>
        <p class="hint">高度图、省份图、地形、河流、生态、地名表和世界文件{w.small.human || hasAnySettle(w) ? '，人文的图、表与档案全文' : ''}</p>
        <PartList w={w} width={width} />
        <div class="row">
          <button disabled={exportProgress.value !== null} onClick={() => void saveFullPng()}>
            <ImageDown /> 整张地图（.png）
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
        <div class="row wrap decor-row">
          {DECOR_KEYS.map((k) => (
            <Toggle on={decor[k]} title={DECOR_TITLES[k]} onChange={(on) => setDecor(k, on)}>
              {DECOR_LABELS[k]}
            </Toggle>
          ))}
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
              titles={{ current: viewProj === 'globe' ? '当前这一面的半球' : '整个椭圆', equirect: '展开成 2:1 的长方形' }}
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
              <Slider stacked label="经度" pos={LON.pos(png.seamLon)} text={lonText(png.seamLon)} textAt={(p) => String(LON.at(p))} entry={String(png.seamLon)} title="打字时西经写成负数" onDraft={(p) => choosePng({ seamLon: LON.at(p) })} onCommit={(p) => choosePng({ seamLon: LON.at(p) })} />
            )}
            <SeamStrip w={w} seamX={seamX} />
            <p class="hint">
              从{lonText(seamLongitude(seamX))}切开展平
            </p>
          </>
        )}
        <p class="hint">
          按当前画风和图层画整张{projected && viewProj === 'globe' ? '半球' : w.mesh.kind === 'sphere' ? '星球' : '地图'}，不含工具的高亮。图越大越慢。
        </p>
        <button onClick={savePng}>
          <ImageDown /> 当前画面（.png）
        </button>
        <p class="hint">屏幕上现在的画面，含地名</p>
      </div>
    </section>
  );
}

// “更多”：历史、偏好（滚轮、第九十九轮的“完整界面”）、帮助（第九十八轮以前叫“上手说明”）
export function MorePanel() {
  return (
    <>
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
        <p class="hint">自动：滚轮缩放，双指滑动平移；认错时选“缩放”或“平移”</p>
        {/* 第九十九轮：简单界面 / 完整界面。整个应用只有这一个开关（ui-prefs.ts），记在这台机器上 */}
        <div class="full-ui">
          <Toggle on={fullUi()} onChange={setFullUi}>
            {SIMPLE_TEXT.toggle}
          </Toggle>
          <p class="hint">{fullUi() ? SIMPLE_TEXT.toggleOn : SIMPLE_TEXT.toggleOff}</p>
        </div>
        {/* 第一百轮：用过笔以后才露的两个开关（touch-ui.ts，记在这个浏览器里） */}
        {penSeen() && (
          <>
            <div class="full-ui">
              <Toggle on={fingerPans()} onChange={setFingerPans}>
                {TOUCH_TEXT.fingerPans}
              </Toggle>
              <p class="hint">{fingerPans() ? TOUCH_TEXT.fingerPansOn : TOUCH_TEXT.fingerPansOff}</p>
            </div>
            <div class="full-ui">
              <Toggle on={penPressure()} onChange={setPenPressure}>
                {TOUCH_TEXT.penPressure}
              </Toggle>
              <p class="hint">{TOUCH_TEXT.penPressureNote}</p>
            </div>
          </>
        )}
      </section>
      {/* 第一百轮：Tab 键的那一下，触摸设备上有按钮 */}
      {touchUi() && (
        <button
          title={TOUCH_TEXT.hideUiNote}
          onClick={() => {
            uiHidden.value = true;
            openPanel.value = null;
          }}
        >
          <EyeOff /> {TOUCH_TEXT.hideUi}
        </button>
      )}
      <button
        title={HELP_KEY_TIP}
        onClick={() => {
          helpOpen.value = true;
          openPanel.value = null;
        }}
      >
        <CircleHelp /> 帮助
      </button>
      {/* 第一百零一轮：有新版本等着时这里也能点（顶上那一条关了以后）；没有时一行灰字说断网也打得开 */}
      <OfflineLine />
    </>
  );
}
