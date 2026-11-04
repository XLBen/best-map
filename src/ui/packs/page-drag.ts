import { signal } from '@preact/signals';
import { showToast } from '../../state';

// 拖卡片（第六十轮）：鼠标、笔按住拖，像 Procreate 叠图层。按下不动是点一下，动了 6 px 才算拖。
// 手指不走这里（按住滑动是滚动面板），触摸时用卡片的“⋯”。Esc 取消。
// 落在哪里、行不行由 judge 算（page-arrange.ts 的 dropVerdict），这里只跟着鼠标走

export interface Judged {
  // 指着的卡片（高亮）；ok：松手有事做；text：鼠标旁边写的一句
  over: string | null;
  ok: boolean;
  text: string;
  // 松手时做的事
  act?: () => void;
  // 不接受：松手时再说一遍
  refuse?: boolean;
}

export interface DragView extends Judged {
  x: number;
  y: number;
  label: string;
  source: string;
}

export const dragView = signal<DragView | null>(null);

const START_PX = 6;
const EDGE_PX = 32;
const SCROLL_PX = 10;

// source：拖的是谁（卡片变淡）；label：跟着鼠标的小卡片上写什么
export function startDrag(down: PointerEvent, o: { source: string; label: string; judge: (el: Element | null) => Judged }) {
  if (down.button !== 0 || down.pointerType === 'touch') return;
  const x0 = down.clientX;
  const y0 = down.clientY;
  let on = false;
  const scroller = (down.target as Element | null)?.closest?.('.lp-body') ?? null;
  // 按住不放时不选中文字（动 6 px 之前也不选）
  const noSelect = (e: Event) => e.preventDefault();
  const update = (x: number, y: number) => {
    const r = o.judge(document.elementFromPoint(x, y));
    dragView.value = { ...r, x, y, label: o.label, source: o.source };
  };
  const move = (e: PointerEvent) => {
    // 在窗口外面松的手：收不到 pointerup
    if (e.buttons === 0) {
      cancel();
      return;
    }
    if (!on) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < START_PX) return;
      on = true;
      document.body.classList.add('lp-dragging');
    }
    e.preventDefault();
    if (scroller) {
      const b = scroller.getBoundingClientRect();
      if (e.clientY < b.top + EDGE_PX) scroller.scrollTop -= SCROLL_PX;
      else if (e.clientY > b.bottom - EDGE_PX) scroller.scrollTop += SCROLL_PX;
    }
    update(e.clientX, e.clientY);
  };
  const finish = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('selectstart', noSelect, true);
    document.body.classList.remove('lp-dragging');
    dragView.value = null;
  };
  // 拖完松手不算点一下（卡片不会点进去）
  const swallowClick = () => {
    const stop = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
  };
  const up = (e: PointerEvent) => {
    const wasOn = on;
    const r = wasOn ? o.judge(document.elementFromPoint(e.clientX, e.clientY)) : null;
    finish();
    if (!wasOn || !r) return;
    swallowClick();
    if (r.ok) r.act?.();
    else if (r.refuse && r.text) showToast(r.text, true);
  };
  const cancel = () => {
    if (on) swallowClick();
    finish();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !on) return;
    e.stopPropagation();
    e.preventDefault();
    cancel();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('selectstart', noSelect, true);
}

// 拖出这一块就拆出来（上级页面上“下面的”一段、列表最上面含的一行）
export function dragOutOf(down: PointerEvent, zone: Element, o: { source: string; label: string; text: string; act: () => void }) {
  startDrag(down, {
    source: o.source,
    label: o.label,
    judge: (el) => (el && zone.contains(el) ? { over: null, ok: false, text: '拖到外面，单独成卡' } : { over: null, ok: true, text: o.text, act: o.act }),
  });
}
