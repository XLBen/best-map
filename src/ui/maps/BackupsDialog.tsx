import { Download, FolderOpen, Trash2 } from 'lucide-preact';
import { ModalHead } from '../common';
import { BACKUP_TEXT as T } from '../copy';
import { backupRow, backups, backupsDialog, canOpenBackup, exportBackup, openBackup, removeBackupAsk } from './backups';

// 留着的旧世界（世界 → 留着的旧世界…，第九十一轮）：这一版打不开的自动保存原样留在这里。一行一份：时间、第几版、几步；
// 右边导出文件、删除（先问）；这一版能打开的（程序更新以后）多一个“打开”

const close = () => (backupsDialog.value = false);

export function BackupsDialog() {
  if (!backupsDialog.value) return null;
  const list = backups.value;
  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal maps" onClick={(e) => e.stopPropagation()}>
        <ModalHead title={T.title} onClose={close} />
        <p class="hint">{T.hint}</p>
        {list === null && <p class="muted">正在读取…</p>}
        {list && list.length === 0 && <p class="muted maps-empty">{T.empty}</p>}
        {list && list.length > 0 && (
          <div class="maps-list">
            {list.map((b) => {
              const row = backupRow(b);
              return (
                <div class="file-row" key={b.id}>
                  <div class="file-info">
                    <div class="file-name">
                      <b title={row.name}>{row.name}</b>
                    </div>
                    <div class="hint ellipsis">{row.note}</div>
                  </div>
                  <div class="file-actions">
                    {canOpenBackup(b) && (
                      <button class="small primary" onClick={() => void openBackup(b.id)}>
                        <FolderOpen /> {T.open}
                      </button>
                    )}
                    <button class="small" onClick={() => void exportBackup(b.id)} title={T.exportTip}>
                      <Download /> {T.export}
                    </button>
                    <button class="small" onClick={() => void removeBackupAsk(b.id)}>
                      <Trash2 /> 删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
