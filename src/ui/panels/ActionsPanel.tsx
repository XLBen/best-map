import { Boxes, CircleHelp, CopyPlus, FileDown, FilePlus, FolderOpen, ImageDown, Library, PackageOpen, Save } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { type WheelPref, download, exportProgress, exportZip, helpOpen, openPanel, prefs, setPrefs, wizardOpen, world } from '../../state';
import { Seg } from '../common';
import type { LabelSize } from '../../render/export-plan';
import { exportFullMap, snapshotCanvas } from '../MapView';
import { HistoryPanel } from '../panels';
import { openPackLibrary } from '../packs/store';
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
const pngChoice: { width: number; labels: LabelSize } = { width: 4096, labels: 'medium' };

const WHEEL: [WheelPref, string][] = [
  ['auto', '自动'],
  ['zoom', '缩放'],
  ['pan', '平移'],
];

export function ActionsPanel() {
  const w = world.value;
  const [width, setWidth] = useState(4096);
  const [png, setPng] = useState({ ...pngChoice });
  if (!w) return null;
  const choosePng = (v: Partial<typeof pngChoice>) => {
    Object.assign(pngChoice, v);
    setPng({ ...pngChoice });
  };
  const savePng = () => {
    const c = snapshotCanvas();
    if (c) c.toBlob((b) => b && download('map.png', b, 'image/png'), 'image/png');
  };
  const saveFullPng = async () => {
    const b = await exportFullMap(png);
    if (b) download('map.png', b, 'image/png');
  };
  // 整张图的高：一块地区按长宽比，整个星球是 2:1
  const pngHeight = (s: number) => Math.round((s * w.mesh.height) / w.mesh.width);
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
        <p class="muted small">
          按现在的画风和图层画出整张{w.mesh.kind === 'sphere' ? '星球（经度 360° 展开成 2:1）' : '地图'}，不管镜头在哪；不带工具的高亮和预览。地名、河按整张图排，字号“大”时标出来的地名少一些。图越大画得越久。
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
