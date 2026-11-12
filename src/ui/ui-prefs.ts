import { signal } from '@preact/signals';

// 简单界面 / 完整界面（第九十九轮）。整个应用只有这一个偏好，记在这台机器上（localStorage；不写进世界、不写进库）：
//   - 关着（默认）是简单界面：工具、底图、图层里的开关、“调整”里的项、资源库首页的卡片只露常用的，
//     资源库里一项的页面只露常用的字段（第九十三轮），来源下拉只有这张地图（第九十二轮）；
//   - 开着是完整界面：全都露着。
// 键还是第九十二轮起的那一个（map2.lib.allSources）：那时它只管资源库的两处，已经打开过它的浏览器照旧是打开的。
// 开关在“更多 → 偏好”。哪些算常用写在各自的声明里（defs/tools/*.ts、defs/layers.ts、defs/adjustments.ts、packs/page-layout.ts 的 more），
// 怎么露是纯函数 defs/simple-ui.ts。
//
// 藏了东西的地方末尾都有一个“还有 N 个”：点了只在这一处展开（再点“只留常用的”收回）。展开过的记在下面的 opened 里，
// 只到这次关页面为止——想一直都露着就开“完整界面”。全应用同一种做法，见 docs/dev/ui-design.md

const KEY = 'map2.lib.allSources';

function read(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

const full = signal(read());
// 是不是完整界面。界面只问这一个函数（资源库里的 showAllSources / showAllSettings 就是它）
export const fullUi = (): boolean => full.value;
export function setFullUi(on: boolean) {
  full.value = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // 存不了就只在这次打开时有效
  }
}

// 这一处是不是点过“还有 N 个”展开着。place：'tools:地形那一类的 id'、'views'、'overlays'、'adjust'、'lib-home'
const opened = signal<ReadonlySet<string>>(new Set());
export const restOpen = (place: string): boolean => opened.value.has(place);
export function setRestOpen(place: string, on: boolean) {
  if (opened.value.has(place) === on) return;
  const next = new Set(opened.value);
  if (on) next.add(place);
  else next.delete(place);
  opened.value = next;
}
// 测试用：都收回
export function closeAllRest() {
  if (opened.value.size) opened.value = new Set();
}
