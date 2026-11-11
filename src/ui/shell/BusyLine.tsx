import { cancelling, progressView, stalled, stopBusy } from '../../state';
import { ProgressBar } from '../components/ProgressBar';
import { STOP_TEXT } from '../copy';
import { busyLineText } from './busy-line';

// 正在算的那一行（第九十七轮）：顶上的提示条、启动时中间那一块、新建向导里用的是同一个——转圈 + 一句话；
// 这一步做了 1 秒以上（state/progress.ts 的 progressView）换成 步名 + 进度条 +“取消”。
// “取消”只有这一个按钮、这一种说法：第九十六轮的“停止”（几秒没动静才出现）并进来了——点了以后先请计算程序在下一步之前停下，
// 它没动静就结束它（state/worker-host.ts 的 stopBusy）；世界都是回到这一步之前。
// text：这个请求自己的提示（“正在计算…”“正在生成世界…”）；tip：按钮悬停时说取消了会怎样；
// plain：只要转圈和那一句（新建向导开着时顶上的提示条：进度和“取消”在向导里，页面上不出两份）
export function BusyLine({ text, tip, plain = false }: { text: string; tip: string; plain?: boolean }) {
  const view = plain ? null : progressView.value;
  const stopping = cancelling.value;
  // 正在恢复世界时没有“取消”（那时再停只会再恢复一次）；没有进度却几秒没动静（不该发生）时照第九十六轮也给
  const canStop = !plain && (view ? view.cancel : stalled.value);
  return (
    <>
      <span class="spinner" />
      <span class={`busy-text ${view ? 'long' : ''}`}>{busyLineText(text, view, stopping)}</span>
      {view && <ProgressBar value={view.fraction} label={text} />}
      {canStop && (
        <button class="pill-btn busy-stop" onClick={() => void stopBusy()} disabled={stopping} title={tip}>
          {STOP_TEXT.stop}
        </button>
      )}
    </>
  );
}
