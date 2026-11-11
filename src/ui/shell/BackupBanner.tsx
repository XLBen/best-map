import { X } from 'lucide-preact';
import { backups, dismissBackups } from '../../state';
import { BACKUP_TEXT as T } from '../copy';
import { backupNotice, exportBackup } from '../maps/backups';

// 上次的世界这一版打不开（第九十一轮）：一直在的一条，要用户自己关；能把那一份原样导出成世界文件。
// 关了以后在“世界 → 留着的旧世界…”里还找得到。box：向导上面的一块（启动时向导盖着地图，横幅在它下面）
export function BackupBanner({ box = false }: { box?: boolean }) {
  const n = backupNotice(backups.value);
  if (!n) return null;
  const actions = (
    <>
      <button class={box ? 'small' : 'pill-btn'} onClick={() => void exportBackup(n.id)} title={T.exportTip}>
        {T.export}
      </button>
      <button class={box ? 'small icon ghost' : 'pill-btn icon'} onClick={() => void dismissBackups()} title="关闭" aria-label="关闭">
        <X />
      </button>
    </>
  );
  if (box) {
    return (
      <div class="box resume backup-note">
        <span>
          {n.text}。<span class="hint">{T.where}</span>
        </span>
        <span class="row">{actions}</span>
      </div>
    );
  }
  return (
    <div class="notice banner">
      <span class="notice-text" title={T.where}>
        {n.text}
      </span>
      {actions}
    </div>
  );
}
