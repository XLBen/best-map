import { signal } from '@preact/signals';

// 资源库面板在这台机器上记着的两样（第九十二轮，localStorage；不写进世界、不写进库）：
// - 来源下拉里要不要把“更多”里的都摊开（直接改我的库、看内置的库……）。默认不摊开：平时只改这张地图。
//   第九十九轮的“完整界面”开关接在 showAllSources 上
// - “存到我的库”存进哪一个库（我的库不止一个时记着上次的）

const ALL_KEY = 'map2.lib.allSources';
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

const allSources = signal(read(ALL_KEY) === '1');
// 来源下拉里是不是把别的来源都摊开。界面只问这一个函数
export const showAllSources = (): boolean => allSources.value;
export function setShowAllSources(on: boolean) {
  allSources.value = on;
  write(ALL_KEY, on ? '1' : null);
}

const mine = signal<string | null>(read(MINE_KEY));
export const rememberedMine = (): string | null => mine.value;
export function rememberMine(key: string | null) {
  mine.value = key;
  write(MINE_KEY, key);
}
