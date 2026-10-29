import { Download, FolderOpen, Pencil, Trash2 } from 'lucide-preact';
import { describeMap } from '../../maps';
import { ModalHead } from '../common';
import { currentMap, deleteSaved, exportSaved, mapList, mapsDialog, openMap, renameSaved } from './store';

// 我的地图（世界 → 我的地图…）：存在这个浏览器里的世界，最近保存的在前。一行一张：小缩略图、名字，下面两行灰字（地区还是星球、格数；保存的时间）；
// 右边打开、改名、导出文件、删掉

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
        <ModalHead title="我的地图" onClose={close} />
        <p class="hint">存在浏览器里，改动自动保存。换电脑或备份用“导出”。</p>
        {list === null && <p class="muted">正在读取…</p>}
        {list && list.length === 0 && <p class="muted maps-empty">没有地图。按 ⌘S 保存当前世界</p>}
        {list && list.length > 0 && (
          <div class="maps-list">
            {list.map((e) => (
              <div class="file-row" key={e.id}>
                <button class="map-thumb" onClick={() => void openMap(e)} title={e.id === open ? '正开着' : `打开“${e.name}”`}>
                  {e.thumb ? <img src={e.thumb} alt="" /> : <span class="hint">无缩略图</span>}
                </button>
                <div class="file-info">
                  <div class="file-name">
                    <b title={e.name}>{e.name}</b>
                    {e.id === open && <span class="tag ok">正开着</span>}
                  </div>
                  <div class="hint ellipsis">{describeMap(e)}</div>
                  <div class="hint ellipsis">{when(e.savedAt)} 保存</div>
                </div>
                <div class="file-actions">
                  <button class="small primary" disabled={e.id === open} onClick={() => void openMap(e)}>
                    <FolderOpen /> 打开
                  </button>
                  <button class="small" onClick={() => void renameSaved(e)}>
                    <Pencil /> 改名
                  </button>
                  <button class="small" onClick={() => void exportSaved(e)} title="下载世界文件，用于换电脑或备份">
                    <Download /> 导出
                  </button>
                  <button class="small" onClick={() => void deleteSaved(e)}>
                    <Trash2 /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
