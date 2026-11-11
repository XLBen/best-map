import { Pencil, Square, Undo2, X } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { busy, canUndo, cancelExport, changeNote, exportProgress, holdNote, scriptRunning, showToastReason, stalled, stopBusy, stopScripts, toast, undo, world } from '../../state';
import { installLateClickGuard, lateClicks } from '../../notice-timer';
import { MISHAP_TEXT, STOP_TEXT } from '../copy';

// 顶部中间的提示条：脚本算了很久（带“停下”）> 出错 > 正在计算 > 一般提示 > 改完后的一句话（带撤销、“换一个”）。
// “停下”排在出错前面：一段一直报平安的慢脚本看门狗不会停，“停下”是唯一的办法，不能被前一步的出错提示（6 秒）挡住。
// 只写改了什么；“28 格地势变了……”这类细节放在鼠标悬停的提示里
// 第九十六轮：不是脚本的请求几秒没算完（state/worker-host.ts 的 stalled）时“正在计算…”旁也有“停止”——同样排在出错前面；
// 出错的提示翻成了人话，原话不一样时多一个“原因”（点了换成能展开、能复制的那一条，shell/MishapBanner.tsx）

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
        {running ? `正在运行“${running}”的脚本…` : '正在运行脚本…'}
        <button class="pill-btn" onClick={stopScripts} title="停止脚本，不做这一步">
          <Square /> 停止
        </button>
      </div>
    );
  }
  // 计算程序几秒没有回过一条：可以停下（世界回到这一步之前）。还没有世界时（启动时打开上次的世界）“停止”在中间那一块上（App.tsx）。
  // 这时“正在计算…”会一直在：这期间说的话（“已导出。还在算的那一步不在里面”、出错）排在它下面，不被它挡住
  if (b && world.value && stalled.value) {
    return (
      <>
        <BusyNotice text={b} stop />
        {t && (t.error ? <ErrorNotice t={t} /> : <div class="notice">{t.text}</div>)}
      </>
    );
  }
  if (t?.error) return <ErrorNotice t={t} />;
  if (b && world.value) return <BusyNotice text={b} />;
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

// 出错的提示；翻成人话以后原话不一样时带“原因”
function ErrorNotice({ t }: { t: NonNullable<typeof toast.value> }) {
  return (
    <div class={`notice error ${t.detail ? 'with-reason' : ''}`}>
      <span class="notice-text">{t.text}</span>
      {t.detail && (
        <button class="pill-btn" onClick={showToastReason} title={MISHAP_TEXT.reasonTip}>
          {MISHAP_TEXT.reason}
        </button>
      )}
    </div>
  );
}

// “正在计算…”；stop：带“停止”
function BusyNotice({ text, stop = false }: { text: string; stop?: boolean }) {
  return (
    <div class="notice">
      <span class="spinner" />
      {text}
      {stop && (
        <button class="pill-btn busy-stop" onClick={() => void stopBusy()} title={STOP_TEXT.tip}>
          <Square /> {STOP_TEXT.stop}
        </button>
      )}
    </div>
  );
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
      {((n.undoable && canUndo.value) || n.undo) && (
        <button
          class="pill-btn"
          onClick={() => {
            if (!n.undo) return void undo();
            n.undo();
            changeNote.value = null;
          }}
        >
          <Undo2 /> 撤销
        </button>
      )}
      {n.action && (
        <button class="pill-btn" onClick={n.action.run}>
          <Pencil /> {n.action.label}
        </button>
      )}
      <button class="pill-btn icon" onClick={() => (changeNote.value = null)} title="关闭">
        <X />
      </button>
    </div>
  );
}
