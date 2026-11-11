import type { ProgressView } from '../../state';
import { PROGRESS_TEXT, STOP_TEXT } from '../copy';

// “正在计算…”那一行写什么（第九十七轮，纯函数，见 busy-line.test.ts）：
//   点了“取消”还没停下：正在取消…；久的一步说到了哪一步：那一步的人话（重放命令时带第几步 / 共几步）；
//   别的（短的、还没说过、不认识的步）：这个请求自己的提示
export function busyLineText(text: string, view: ProgressView | null, cancelling: boolean): string {
  if (cancelling) return STOP_TEXT.cancelling;
  if (!view || !view.step) return text;
  if (view.step === 'replay') return view.count ? PROGRESS_TEXT.replay(view.count.k, view.count.n) : text;
  return PROGRESS_TEXT.steps[view.step] ?? text;
}
