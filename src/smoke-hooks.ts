import { signal } from '@preact/signals';

// 冒烟（tools/smoke.mjs）要“画界面时抛一个错”，从外面做不到（别的几样——让计算程序忙等、丢掉 WebGL 的上下文、在点击里抛错——
// 冒烟经调试协议自己就能做，不用程序配合）。所以留这一个钩子：
//   - 只在打开页面时网址的 # 后面正是 SMOKE_HASH 才装（普通用户不会打这一串；界面上没有任何地方通向它）；
//   - 装了也只是在 window 上多一个函数，不调用它什么都不发生；
//   - 没装时 SmokeBomb 永远什么都不画。
export const SMOKE_HASH = '#map2-smoke-96';

// 要在哪里抛：root 界面的最外层（整个界面画不出来 → 自救页）；part 一块里面（只关上那一块、顶上说一句）
const bomb = signal<'root' | 'part' | null>(null);
let partArmed = false;

export function installSmokeHooks() {
  if (typeof location === 'undefined' || location.hash !== SMOKE_HASH) return;
  (window as unknown as { __map2Smoke?: unknown }).__map2Smoke = {
    crashRender: (where: 'root' | 'part' = 'root') => {
      if (where === 'part') partArmed = true;
      bomb.value = where;
    },
  };
}

// 界面里的一个空部件：冒烟叫它抛时，画到它就抛
export function SmokeBomb({ at }: { at: 'root' | 'part' }) {
  if (bomb.value === at) {
    // 一块里面的只抛一次（那一块下次再画时照常）
    if (at === 'part') {
      if (!partArmed) return null;
      partArmed = false;
    }
    throw new Error(at === 'root' ? '冒烟：画整个界面时抛的错' : '冒烟：画一块时抛的错');
  }
  return null;
}
