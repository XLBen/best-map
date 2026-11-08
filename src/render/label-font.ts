// 画风的地名字体（第八十七轮）：画布上的字用到网页字体（霞鹜文楷，按 unicode-range 切成小文件）时，按字请浏览器先载入那几个小文件。
// 载入完成时 document 的 fonts 发 loadingdone：overlay-base.ts 清掉字宽、overlay-static.ts 让静态那一层重画

const asked = new Map<string, Set<string>>();

// 请浏览器载入这些字（只请没请过的）：屏幕上排地名时调，不等它
export function askGlyphs(family: string, texts: Iterable<string>): void {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  let seen = asked.get(family);
  if (!seen) asked.set(family, (seen = new Set()));
  let fresh = '';
  for (const t of texts)
    for (const c of t) {
      if (seen.has(c)) continue;
      seen.add(c);
      fresh += c;
    }
  if (fresh) void document.fonts.load(`500 16px ${family}`, fresh).catch(() => {});
}

// 导出前：等这些字载入好，最多等 timeout 毫秒（载不到时照样导出，用后备的字体）
export async function loadGlyphs(family: string, texts: Iterable<string>, timeout = 8000): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  let all = '';
  for (const t of texts) all += t;
  if (!all) return;
  const chars = [...new Set(all)].join('');
  const wait = Promise.all([document.fonts.load(`500 16px ${family}`, chars), document.fonts.load(`600 16px ${family}`, chars)]).catch(() => []);
  await Promise.race([wait, new Promise((r) => setTimeout(r, timeout))]);
}
