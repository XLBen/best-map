import { signal } from '@preact/signals';

// 新建向导在这台机器上记着的一样（第九十八轮，localStorage；不写进世界）：“自定义…”展开过没有。
// 展开过的人下次打开向导还是展开的；没展开过的第一屏只有缩略图。写法同 packs/lib-prefs.ts

const KEY = 'map2.wizard.custom';

function read(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

const custom = signal(read());
export const wizardCustom = (): boolean => custom.value;
export function setWizardCustom(on: boolean) {
  custom.value = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // 存不了就只在这次打开时有效
  }
}
