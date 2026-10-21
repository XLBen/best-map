import { CircleHelp, FilePlus, FolderOpen, ImageDown, PackageOpen, Save } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { WorldDoc } from '../../../core/engine';
import { type WheelPref, download, exportZip, getDoc, helpOpen, loadDoc, openPanel, prefs, setPrefs, wizardOpen, world } from '../../state';
import { Seg } from '../common';
import { snapshotCanvas } from '../MapView';
import { HistoryPanel } from '../panels';

// “世界”：新建、打开、保存；“操作”：导出、历史、上手说明、偏好

export function WorldMenu() {
  return (
    <div class="menu">
      <button
        class="menu-row"
        onClick={() => {
          wizardOpen.value = true;
          openPanel.value = null;
        }}
      >
        <FilePlus size={18} />
        <span>
          <b>新世界…</b>
          <span class="how">选世界的类型、大小和在星球上的位置，从几张小图里挑一张</span>
        </span>
      </button>
      <label class="menu-row file-button">
        <FolderOpen size={18} />
        <span>
          <b>打开世界文件…</b>
          <span class="how">接着改以前保存的世界（.json）</span>
        </span>
        <input
          type="file"
          accept="application/json"
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void f.text().then((t) => loadDoc(JSON.parse(t) as WorldDoc));
            (e.target as HTMLInputElement).value = '';
            openPanel.value = null;
          }}
        />
      </label>
      <button
        class="menu-row"
        disabled={!world.value}
        onClick={async () => {
          const doc = await getDoc();
          if (doc) download('world.json', JSON.stringify(doc), 'application/json');
        }}
      >
        <Save size={18} />
        <span>
          <b>保存世界文件</b>
          <span class="how">所有编辑都在里面，之后可以打开继续改</span>
        </span>
      </button>
      <p class="muted small">浏览器里会自动保存最近一次的世界；换电脑或想留备份时，用“保存世界文件”。</p>
    </div>
  );
}

const WHEEL: [WheelPref, string][] = [
  ['auto', '自动'],
  ['zoom', '缩放'],
  ['pan', '平移'],
];

export function ActionsPanel() {
  const w = world.value;
  const [width, setWidth] = useState(4096);
  if (!w) return null;
  const savePng = () => {
    const c = snapshotCanvas();
    if (c) c.toBlob((b) => b && download('map.png', b, 'image/png'), 'image/png');
  };
  return (
    <>
      <section>
        <h5>导出</h5>
        <div class="row">
          <button
            class="primary"
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
        <button onClick={savePng}>
          <ImageDown size={16} /> 保存当前画面（.png）
        </button>
        <p class="muted small">存的是屏幕上现在看到的地图（含地名）。想要整张图，先按 F 看全图。</p>
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
