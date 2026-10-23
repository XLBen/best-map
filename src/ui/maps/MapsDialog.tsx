import { Download, FolderOpen, Pencil, Trash2 } from 'lucide-preact';
import { describeMap } from '../../maps';
import { currentMap, deleteSaved, exportSaved, mapList, mapsDialog, openMap, renameSaved } from './store';

// 我的地图（世界 → 我的地图…）：存在这个浏览器里的世界，最近保存的在前。每一张：缩略图、名字、地区还是星球、时间、格数；
// 打开、改名、导出文件、删掉

const close = () => (mapsDialog.value = false);

function when(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? `今天 ${time}` : `${d.toLocaleDateString()} ${time}`;
}

export function MapsDialog() {
  if (!mapsDialog.value) return null;
  const list = mapList.value;
  const open = currentMap.value?.id ?? null;
  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal maps" onClick={(e) => e.stopPropagation()}>
        <div class="row between">
          <h2>我的地图</h2>
          <button onClick={close}>关上</button>
        </div>
        <p class="muted small">存在这个浏览器里。保存过的世界改了之后会自动保存；换电脑或留备份时用“导出文件”。</p>
        {list === null && <p class="muted">正在读…</p>}
        {list && list.length === 0 && <p class="muted maps-empty">还没有保存的地图。按 ⌘S 保存当前的世界</p>}
        {list?.map((e) => (
          <div class={`map-row ${e.id === open ? 'on' : ''}`} key={e.id}>
            <button class="map-thumb" onClick={() => void openMap(e)} title={e.id === open ? '正开着' : `打开「${e.name}」`}>
              {e.thumb ? <img src={e.thumb} alt="" /> : <span class="muted small">没有缩略图</span>}
            </button>
            <div class="map-info">
              <b>{e.name}</b>
              {e.id === open && <span class="tag">正开着</span>}
              <div class="muted small">{describeMap(e)}</div>
              <div class="muted small">{when(e.savedAt)} 保存</div>
              <div class="row wrap map-actions">
                <button class="primary" disabled={e.id === open} onClick={() => void openMap(e)}>
                  <FolderOpen size={14} /> 打开
                </button>
                <button onClick={() => void renameSaved(e)}>
                  <Pencil size={14} /> 改名
                </button>
                <button onClick={() => void exportSaved(e)} title="下载成世界文件（.json），换电脑或留备份">
                  <Download size={14} /> 导出文件
                </button>
                <button onClick={() => void deleteSaved(e)}>
                  <Trash2 size={14} /> 删掉
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
