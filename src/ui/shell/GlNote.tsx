import { autosaveNow, flushNow, glReason, glState, skipLeaveWarning, unsaved } from '../../state';
import { GL_TEXT as T } from '../copy';
import { exportCurrent } from '../maps/store';
import { glNote } from './gl-note';

// 地图的画面（WebGL）暂时不可用、恢复不了、画不出来时盖在地图中间的一块（第九十六轮；规则在 render/gl-recover.ts，写什么在 gl-note.ts）。
// 界面别的部分照常：能导出文件、能保存
export function GlNote() {
  const n = glNote(glState.value, unsaved.value);
  if (!n) return null;
  const reload = () => {
    // 先把没写的尾巴写进浏览器；都存好了浏览器就不用再问“要离开吗”
    flushNow();
    void autosaveNow().finally(() => {
      if (!unsaved.peek()) skipLeaveWarning();
      location.reload();
    });
  };
  return (
    <div class={`gl-note ${n.busy ? 'busy' : ''}`} role="status" title={glReason.value || undefined}>
      {n.busy && <span class="spinner" />}
      <span class="gl-note-text">{n.text}</span>
      {n.actions.map((a) =>
        a === 'reload' ? (
          <button class="primary" onClick={reload}>
            {T.reload}
          </button>
        ) : (
          <button onClick={() => void exportCurrent()}>{T.export}</button>
        ),
      )}
    </div>
  );
}
