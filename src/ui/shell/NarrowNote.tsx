import { X } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { TOUCH_TEXT } from '../copy';
import { narrowScreen } from '../touch-ui';

// 第一百轮：手机不是目标（顶栏、底部条、面板在不到 600 像素宽的屏幕上放不开）。打开时在最上面说一句，不拦着用；
// 过一会儿自己收起（它盖着顶栏的一行），也可以点 × 关上；这次打开页面不再说。向导、弹窗开着时也看得到（在它们上面）
export const NARROW_NOTE_MS = 8000;
export function NarrowNote() {
  const [closed, setClosed] = useState(false);
  const show = narrowScreen.value && !closed;
  useEffect(() => {
    if (!show) return;
    const h = setTimeout(() => setClosed(true), NARROW_NOTE_MS);
    return () => clearTimeout(h);
  }, [show]);
  if (!show) return null;
  return (
    <div class="narrow-note" role="status">
      <span>{TOUCH_TEXT.narrow}</span>
      <button class="icon-btn" onClick={() => setClosed(true)} title="关闭" aria-label="关闭">
        <X />
      </button>
    </div>
  );
}
