import { Check, CircleDashed, CirclePlus } from 'lucide-preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ContentRef } from '../../../core/content/links';
import type { ImportNeed } from '../../../core/packs/closure';
import type { PageCtx } from './pages';
import { type PickView, boxOf, lookOf, pressOf, pressRow } from './pick-view';

// 一行最左边的勾（第六十七轮，资源库面板的列表、融入的子项、一项的页面顶上）：
//   ✓ 已经有了；虚线圈 灰的、这个库里没有它要的（悬停写原因）；圈里加号 灰的、点了把它要的一起勾上（几个里选一个时弹小菜单）；
//   别的是勾选框（跟着来的是半勾）。按住空格的行由面板的键盘处理点它（.lp-pick）

function ChoiceMenu({ at, choices, onPick, onClose }: { at: { top: number; left: number }; choices: readonly ImportNeed[]; onPick: (n: ImportNeed) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', off, true);
    box.current?.querySelector('button')?.focus();
    return () => window.removeEventListener('pointerdown', off, true);
  }, []);
  // 挂在 body 上：面板的毛玻璃（backdrop-filter）让 position: fixed 按面板算，菜单会跑到面板外、被裁掉
  return createPortal(
    <div
      class="lp-source-menu lp-choice-menu"
      ref={box}
      style={{ top: at.top, left: at.left }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <h6 class="lp-menu-group">选一个一起勾上</h6>
      {choices.map((n) => (
        <button class="item" key={`${n.kind}:${n.id}`} onClick={() => onPick(n)}>
          <span class="grow ellipsis">{n.name}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function PickBox({ v, r, ctx }: { v: PickView; r: ContentRef; ctx: PageCtx }) {
  const look = lookOf(v, r);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const press = pressOf(look);
  if (look.mark === 'have') {
    return (
      <span class="lp-pick have" title="已经有了">
        <Check />
      </span>
    );
  }
  if (press.t === 'none') {
    return (
      <span class="lp-pick grey" title={look.note ?? undefined}>
        <CircleDashed />
      </span>
    );
  }
  if (press.t === 'needs') {
    const choices = press.choices;
    return (
      <>
        <button
          class="icon-btn lp-pick grey can"
          title={`${look.note ?? ''}。${choices.length ? '点一下选一个，一起勾上' : '点一下，要的一起勾上'}`}
          onClick={(e) => {
            if (pressRow(v.key, r, look, ctx) || !choices.length) return;
            const b =(e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({ top: b.bottom + 4, left: b.left });
          }}
        >
          <CirclePlus />
        </button>
        {menu && (
          <ChoiceMenu
            at={menu}
            choices={choices}
            onClose={() => setMenu(null)}
            onPick={(n) => {
              setMenu(null);
              pressRow(v.key, r, look, ctx, { kind: n.kind, id: n.id });
            }}
          />
        )}
      </>
    );
  }
  const b = boxOf(look);
  return (
    <label class="lp-pick check" title={look.mark === 'follow' ? `${look.note ?? ''}。勾上带上整项` : undefined} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={b.checked}
        ref={(el) => {
          if (el) el.indeterminate = b.mixed;
        }}
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          pressRow(v.key, r, look, ctx);
          // 跟着来的点了之后不一定变成勾（看勾选算出来的）：显示跟着状态走
          el.checked = b.checked;
          el.indeterminate = b.mixed;
        }}
      />
    </label>
  );
}
