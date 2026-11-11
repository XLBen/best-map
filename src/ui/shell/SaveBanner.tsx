import { saveProblem } from '../../state';
import { SAVE_TEXT as T } from '../copy';
import { exportCurrent } from '../maps/store';
import { takeOverHere } from './save-note';

// 这个世界已在另一个页面打开（第九十四轮）：这个页面不写自动保存，顶上一直有这一条，直到点“在这里接着做”或者那个页面关了。
// 没存成的别的原因（存储满了……）不在这里：顶上说一次，之后看顶栏“世界”旁的记号
export function SaveBanner() {
  if (saveProblem.value !== 'other-page') return null;
  return (
    <div class="notice banner">
      <span class="notice-text">{T.otherPage}</span>
      <button class="pill-btn" onClick={() => void takeOverHere()} title={T.takeOverTip}>
        {T.takeOver}
      </button>
      <button class="pill-btn" onClick={() => void exportCurrent()} title={T.exportTip}>
        {T.export}
      </button>
    </div>
  );
}
