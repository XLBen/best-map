import { signal } from '@preact/signals';
import { fullUi, setFullUi } from '../ui-prefs';

// 资源库面板在这台机器上记着的两样（第九十二轮，localStorage；不写进世界、不写进库）：
// - 来源下拉里要不要把“更多”里的都摊开（直接改我的库、看内置的库……）。默认不摊开：平时只改这张地图。
// - “存到我的库”存进哪一个库（我的库不止一个时记着上次的）
//
// 第九十三轮：一项的页面上“更多设置”要不要都摊开，问 showAllSettings()。
// 第九十九轮：这两问就是全局的“完整界面”（ui-prefs.ts 的 fullUi：同一个偏好、同一个键 map2.lib.allSources、同一个信号），
// 开关在“更多 → 偏好”。资源库里照旧分两个函数问：以后要分开时只改这里，组件不用动

const MINE_KEY = 'map2.lib.mine';

function read(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    // 存不了就只在这次打开时有效
  }
}

// 来源下拉里是不是把别的来源都摊开。界面只问这一个函数
export const showAllSources = fullUi;
export const setShowAllSources = setFullUi;

// 一项的页面上是不是把“更多设置”都摊开（不折叠、不收进页面底下）。和来源下拉的“更多”共用一个偏好，见文件开头
export const showAllSettings = fullUi;
export const setShowAllSettings = setFullUi;

const mine = signal<string | null>(read(MINE_KEY));
export const rememberedMine = (): string | null => mine.value;
export function rememberMine(key: string | null) {
  mine.value = key;
  write(MINE_KEY, key);
}
