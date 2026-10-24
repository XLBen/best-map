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
          <button onClick={close}>关闭</button>
        </div>
        <p class="hint">存在浏览器里，改动自动保存。换电脑或备份用“导出”。</p>
        {list === null && <p class="muted">正在读取…</p>}
        {list && list.length === 0 && <p class="muted maps-empty">没有地图。按 ⌘S 保存当前世界</p>}
        {list?.map((e) => (
          <div class="item big" key={e.id}>
            <button class="map-thumb" onClick={() => void openMap(e)} title={e.id === open ? '正开着' : `打开“${e.name}”`}>
              {e.thumb ? <img src={e.thumb} alt="" /> : <span class="hint">无缩略图</span>}
            </button>
            <div class="map-info">
              <b>{e.name}</b>
              {e.id === open && <span class="tag ok">正开着</span>}
              <div class="hint">{describeMap(e)}</div>
              <div class="hint">{when(e.savedAt)} 保存</div>
              <div class="row wrap map-actions">
                <button class="primary" disabled={e.id === open} onClick={() => void openMap(e)}>
                  <FolderOpen /> 打开
                </button>
                <button onClick={() => void renameSaved(e)}>
                  <Pencil /> 改名
                </button>
                <button onClick={() => void exportSaved(e)} title="下载世界文件，用于换电脑或备份">
                  <Download /> 导出
                </button>
                <button onClick={() => void deleteSaved(e)}>
                  <Trash2 /> 删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
