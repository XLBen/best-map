import { Dices, Pencil, Undo2, X } from 'lucide-preact';
import { busy, canUndo, cancelExport, changeNote, exportProgress, toast, undo, world } from '../../state';

// 顶部中间的提示条：出错 > 正在计算 > 一般提示 > 改完后的一句话（带撤销、“换一个”）。
// 只写改了什么；“28 格地势变了……”这类细节放在鼠标悬停的提示里

export function Notice() {
  const t = toast.value;
  const b = busy.value;
  const n = changeNote.value;
  if (t?.error) return <div class="notice error">{t.text}</div>;
  if (b && world.value) {
    return (
      <div class="notice">
        <span class="spinner" />
        {b}
      </div>
    );
  }
  const ex = exportProgress.value;
  if (ex !== null && world.value) {
    return (
      <div class="notice">
        <span class="spinner" />
        正在导出… {Math.round(ex * 100)}%
        <button class="pill-btn" onClick={cancelExport}>
          取消
        </button>
      </div>
    );
  }
  if (t) return <div class="notice">{t.text}</div>;
  if (!n) return null;
  return (
    <div class="notice">
      <span class="notice-text" title={n.detail || undefined}>
        <b>{n.head}</b>
      </span>
      {n.undoable && canUndo.value && (
        <button class="pill-btn" onClick={() => void undo()}>
          <Undo2 size={14} /> 撤销
        </button>
      )}
      {n.again && (
        <button class="pill-btn" onClick={n.again.run} title="撤掉这一步，换一个重新放">
          <Dices size={14} /> {n.again.label}
        </button>
      )}
      {n.action && (
        <button class="pill-btn" onClick={n.action.run}>
          <Pencil size={14} /> {n.action.label}
        </button>
      )}
      <button class="pill-btn icon" onClick={() => (changeNote.value = null)} title="关上">
        <X size={14} />
      </button>
    </div>
  );
}
