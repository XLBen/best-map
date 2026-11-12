import { signal } from '@preact/signals';

// 触摸与笔（第一百轮）：这台设备是不是在用手指 / 笔、用笔的人的两个偏好、屏幕上代替 Shift / Alt 的两个开关。
// 都只记在这个浏览器里（localStorage 的 map2.touch），不写进世界。
//
// 规矩（docs/dev/ui-design.md“触摸”一节）：只有键盘、右键、悬停才做得到的事，补上的按钮只在 touchUi() 为真时露——
// 鼠标下界面一个像素都不变。尺寸放大的样式另在 shell/touch.css 的 @media (pointer: coarse) 里

const KEY = 'map2.touch';

interface Stored {
  // 用过笔：偏好里露出“手指只移动地图”“笔的压力影响力度”
  pen: boolean;
  // 手指只移动地图（不画）：像 Procreate，默认关
  fingerPans: boolean;
  // 笔的压力影响力度：默认关
  penPressure: boolean;
}

// 存着的那一份读回来：不认识的都当没开
export function parseTouch(raw: string | null): Stored {
  let p: Partial<Stored> = {};
  try {
    p = raw ? (JSON.parse(raw) as Partial<Stored>) : {};
  } catch {
    // 坏了就全用默认的
  }
  return { pen: p?.pen === true, fingerPans: p?.fingerPans === true, penPressure: p?.penPressure === true };
}

function read(): Stored {
  try {
    return parseTouch(typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null);
  } catch {
    return parseTouch(null);
  }
}

const stored = signal<Stored>(read());
function save(patch: Partial<Stored>) {
  stored.value = { ...stored.value, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(stored.value));
  } catch {
    // 存不了就只在这次打开时有效
  }
}

export const penSeen = (): boolean => stored.value.pen;
// 两个偏好只在用过笔以后才露、才起作用（没有笔的人开不了它，也就不会被它困住：手指不画了又没有笔）
export const fingerPans = (): boolean => stored.value.pen && stored.value.fingerPans;
export const penPressure = (): boolean => stored.value.pen && stored.value.penPressure;
export const setFingerPans = (on: boolean) => save({ fingerPans: on });
export const setPenPressure = (on: boolean) => save({ penPressure: on });

// 主要的指针是粗的（平板、手机）：媒体查询说的
const coarse = signal(false);
// 这次打开页面用过手指或笔（带触摸屏的笔记本：主要的指针是鼠标，但手指点过）
const touched = signal(false);

// 该不该露出给触摸补的按钮（多选、汇入、看全图……）
export const touchUi = (): boolean => coarse.value || touched.value;

// 收到一次手指 / 笔的按下（地图上的、界面上的都算）
export function noteTouch(kind: string) {
  if (kind !== 'touch' && kind !== 'pen') return;
  if (!touched.peek()) touched.value = true;
  if (kind === 'pen' && !stored.peek().pen) save({ pen: true });
}

// 手指正按在地图上（touch-wire.ts 记）：鼠标旁的那句话这时写在手指上面，不被手指挡着
export const fingerOnMap = signal(false);

// ---------- 屏幕上的 Shift / Alt ----------

// 没有键盘的人按不了 Shift、Alt：用得上它们的工具在底部条上各有一个开关（工具表的 mods，“多选”“汇入”……），
// 开着时地图上的每一下都当作按着那个键。换工具就关上
export const held = signal<{ shift: boolean; alt: boolean }>({ shift: false, alt: false });
export function setHeld(key: 'shift' | 'alt', on: boolean) {
  if (held.peek()[key] !== on) held.value = { ...held.peek(), [key]: on };
}
export function releaseHeld() {
  const h = held.peek();
  if (h.shift || h.alt) held.value = { shift: false, alt: false };
}

// ---------- 工具的那一句 ----------

// 工具做什么（工具表的 how）平时在按钮的悬停里；手指没有悬停，触摸设备上写在底部条最下面一行。
// 那一句里讲键盘的半句（“Shift 反过来”“Alt+点击吸取”）去掉：屏幕上有对应的开关、吸管
export function howForTouch(how: string): string {
  const kept = how.split('；').filter((part) => !/Shift|Alt|Delete|Esc/.test(part));
  return kept.length ? kept.join('；') : how;
}

// ---------- 屏幕太窄 ----------

// 手机不是目标：宽度不到这么多（CSS 像素）时打开说一句，不拦着用
export const NARROW_PX = 600;
export const narrowScreen = signal(false);

// 在页面起来时调一次（main.tsx）：听媒体查询、窗口宽度、第一次手指 / 笔的按下
export function startTouchUi() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia('(pointer: coarse)');
  coarse.value = mq.matches;
  mq.addEventListener?.('change', (e) => (coarse.value = e.matches));
  const narrow = window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`);
  narrowScreen.value = narrow.matches;
  narrow.addEventListener?.('change', (e) => (narrowScreen.value = e.matches));
  window.addEventListener('pointerdown', (e) => noteTouch(e.pointerType), true);
}

// 测试用：回到刚打开页面、没用过手指和笔的样子
export function resetTouchUi(opts: Partial<Stored> & { coarse?: boolean; touched?: boolean } = {}) {
  stored.value = { pen: opts.pen ?? false, fingerPans: opts.fingerPans ?? false, penPressure: opts.penPressure ?? false };
  coarse.value = opts.coarse ?? false;
  touched.value = opts.touched ?? false;
  held.value = { shift: false, alt: false };
  fingerOnMap.value = false;
}
