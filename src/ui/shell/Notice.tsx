import { Dices, Pencil, Square, Undo2, X } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { busy, canUndo, cancelExport, changeNote, exportProgress, holdNote, scriptRunning, stopScripts, toast, undo, world } from '../../state';
import { installLateClickGuard, lateClicks } from './noticeTimer';

// 顶部中间的提示条：脚本算了很久（带“停下”）> 出错 > 正在计算 > 一般提示 > 改完后的一句话（带撤销、“换一个”）。
// “停下”排在出错前面：一段一直报平安的慢脚本看门狗不会停，“停下”是唯一的办法，不能被前一步的出错提示（6 秒）挡住。
// 只写改了什么；“28 格地势变了……”这类细节放在鼠标悬停的提示里

export function Notice() {
  const t = toast.value;
  const b = busy.value;
  const n = changeNote.value;
  const running = scriptRunning.value;
  // 一段脚本算了 1.5 秒以上：可以停下（这一步不做，世界用之前的样子恢复）
  if (running !== null) {
    return (
      <div class="notice">
        <span class="spinner" />
        {running ? `正在运行「${running}」的脚本…` : '正在运行脚本…'}
        <button class="pill-btn" onClick={stopScripts} title="停掉这段脚本，这一步不做">
          <Square size={12} /> 停下
        </button>
      </div>
    );
  }
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
  return <ChangeNote n={n} />;
}

// 改完后的一句话（带撤销等按钮）：鼠标停在上面时不消失；消失后 300 毫秒内按在它原来位置上的一下不落到地图上
function ChangeNote({ n }: { n: NonNullable<typeof changeNote.value> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    lateClicks.shown(r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null);
  });
  useEffect(() => {
    installLateClickGuard();
    return () => {
      lateClicks.gone();
      // 鼠标停着时提示条被关上、被别的提示换掉：计时接着算（不然下一句一直不消失）
      holdNote(false);
    };
  }, []);
  return (
    <div class="notice" ref={ref} onPointerEnter={() => holdNote(true)} onPointerLeave={() => holdNote(false)}>
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
