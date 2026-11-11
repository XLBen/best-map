import { Download, FolderOpen, History, Trash2 } from 'lucide-preact';
import type { VersionInfo } from '../../versions';
import { currentSeries } from '../../state';
import { ModalHead } from '../common';
import { VERSION_TEXT as T } from '../copy';
import { exportVersion, removeVersionAsk, restoreVersion, versionGroups, versionRow, versions, versionsDialog } from './versions';

// 以前的版本（世界 → 以前的版本…；我的地图里每张的“版本”，第九十五轮）：自动留的几份，最近的在前。
// 一行一份：小缩略图、时间，下面一行灰字（几步、为什么留的）；右边回到这一份（别的没存的世界是“打开”）、导出文件、删除（先问）

const close = () => (versionsDialog.value = null);

function Row({ v, current, now }: { v: VersionInfo; current: boolean; now: number }) {
  const row = versionRow(v, now);
  return (
    <div class="file-row">
      <span class="map-thumb version-thumb">{v.thumb ? <img src={v.thumb} alt="" /> : <span class="hint">无缩略图</span>}</span>
      <div class="file-info">
        <div class="file-name">
          <b title={row.when}>{row.when}</b>
        </div>
        <div class="hint ellipsis">{row.note}</div>
      </div>
      <div class="file-actions">
        <button class="small primary" onClick={() => void restoreVersion(v)} title={current ? T.restoreTip : T.openTip}>
          {current ? <History /> : <FolderOpen />} {current ? T.restore : T.open}
        </button>
        <button class="small" onClick={() => void exportVersion(v)} title={T.exportTip}>
          <Download /> {T.export}
        </button>
        <button class="small" onClick={() => void removeVersionAsk(v)}>
          <Trash2 /> 删除
        </button>
      </div>
    </div>
  );
}

export function VersionsDialog() {
  const scope = versionsDialog.value;
  if (!scope) return null;
  const list = versions.value;
  const now = Date.now();
  const groups = list ? versionGroups(list, scope, currentSeries.value) : [];
  const none = groups.every((g) => g.rows.length === 0);
  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal maps" onClick={(e) => e.stopPropagation()}>
        <ModalHead title={scope.t === 'map' ? T.titleOf(scope.name) : T.title} onClose={close} />
        <p class="hint">{T.hint}</p>
        {list === null && <p class="muted">正在读取…</p>}
        {list && none && <p class="muted maps-empty">{T.empty}</p>}
        {list &&
          !none &&
          groups.map((g, k) => (
            <section key={k}>
              {g.title && <h5>{g.title}</h5>}
              {g.hint && <p class="hint">{g.hint}</p>}
              {/* 看一张没开着的地图：回到这一份就是打开它那时的样子，照样先把它现在的样子留一份 */}
              {g.rows.length > 0 && (
                <div class="maps-list">
                  {g.rows.map((v) => (
                    <Row key={v.id} v={v} current={g.current || scope.t === 'map'} now={now} />
                  ))}
                </div>
              )}
              {g.current && g.rows.length === 0 && <p class="muted">{T.empty}</p>}
            </section>
          ))}
      </div>
    </div>
  );
}
