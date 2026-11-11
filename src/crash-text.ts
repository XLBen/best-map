// 出了问题时说的话（第九十六轮）。ui/copy.ts 照旧导出这里的全部；单放一个不引用任何东西的文件，是因为整页的自救页（rescue.ts）
// 在程序别的部分坏了的时候也要写得出字。写法照 docs/dev/ui-design.md：每一句说清发生了什么、作品还在不在、现在能做什么

// 自救页上“你的世界”那一行：现在知道多少
//   checking 正在看浏览器里有没有存着的；live 页面里的世界还拿得到、也存进浏览器了；live-unsaved 拿得到，但最后几步没来得及存；
//   saved 页面里的拿不到，浏览器里存着一份；partial 存着的那一份不完整；none 哪里都没有
export type RescueWorld = 'checking' | 'live' | 'live-unsaved' | 'saved' | 'partial' | 'none';

export const RESCUE_TEXT = {
  // 整个界面画不出来
  crash: {
    title: '页面出了问题',
    lead: '界面没能接着显示。请先导出文件，再重新载入。',
  },
  // 浏览器画不了地图（不支持 WebGL2、显卡不行）
  noWebgl: {
    title: '这个浏览器画不了地图',
    lead: '地图用 WebGL2 来画，这里用不了。请换新版的 Chrome、Edge、Firefox 或 Safari 打开；已经是新版时，在浏览器的设置里打开“硬件加速”，再重新载入。',
  },
  world: {
    checking: '正在看浏览器里存着的世界…',
    live: '你的世界还在浏览器里，重新载入后接着做。',
    'live-unsaved': '你的世界还在这个页面里，最后几步没来得及存进浏览器。请先导出文件。',
    saved: (when: string) => `你的世界还在浏览器里，是${when} 存的。重新载入后接着做。`,
    partial: (when: string) => `浏览器里存着的世界不完整，是${when} 存的。导出的是存下的那一部分。`,
    none: '浏览器里没有存着的世界，没有东西会丢。',
  } satisfies Record<RescueWorld, string | ((when: string) => string)>,
  export: '导出文件',
  exportTip: '把你的世界存成世界文件',
  reload: '重新载入',
  reason: '原因',
  copy: '复制',
  copied: '已复制',
  exported: (name: string) => `已导出“${name}”。`,
  exportedPartial: (name: string) => `已导出“${name}”，是存下的那一部分。`,
  exportFailed: '没能导出。请不要关这个页面，换一个浏览器窗口打开同一个地址试试。',
} as const;

// “今天 14:05”“昨天 09:12”“11月3日 20:10”（和“以前的版本”里的写法一样；这里自己写一份，不引用界面）
export function rescueWhen(at: number, now: number): string {
  if (!at) return '以前';
  const d = new Date(at);
  const n = new Date(now);
  const two = (v: number) => String(v).padStart(2, '0');
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// 自救页上“你的世界”那一行
export function rescueWorldLine(w: RescueWorld, savedAt: number, now: number): string {
  const t = RESCUE_TEXT.world[w];
  return typeof t === 'function' ? t(rescueWhen(savedAt, now)) : t;
}

// 不致命的错：顶上的一条（界面还能用）
export const MISHAP_TEXT = {
  // 没接住的错：不知道是哪一步，只说可能
  generic: '刚才那一步可能没做成。世界还在，可以接着用',
  // 某一块（面板、弹窗）画不出来，已经关闭
  part: (name: string) => `“${name}”出了问题，已经关闭。世界还在，可以接着用`,
  reason: '原因',
  reasonTip: '看原话',
  copy: '复制',
  copied: '已复制',
  times: (n: number) => `出了 ${n} 次`,
} as const;

// “取消”（不是脚本的请求也能停；第九十六轮叫“停止”，第九十七轮和进度条旁的按钮并成一个说法）、不死等计算程序时说的话
export const STOP_TEXT = {
  stop: '取消',
  // 点了以后、计算程序在下一步之前停下之前
  cancelling: '正在取消…',
  // 进度条旁的
  tip: '不做这一步了，世界回到这一步之前',
  // 启动时正在打开上次的世界
  openTip: '不打开了。上次的世界还留在浏览器里',
  // 新建向导里正在生成、正在打开上次的世界
  wizardTip: '不生成了，回到这里重新选',
  // 启动时取消以后
  openStopped: '已取消。上次的世界还留在浏览器里',
} as const;

// 地图的画面（WebGL）出了事：盖在地图上的一层
export const GL_TEXT = {
  lost: '画面暂时不可用，正在恢复…',
  // 等了一阵没恢复
  stuck: '画面没能恢复。',
  // 重建时出错、连着几帧画不出来
  broken: '地图画不出来了。',
  saved: '这张地图已存在浏览器里，重新载入后接着做。',
  unsaved: '这张地图还有改动没存好，请先导出文件，再重新载入。',
  reload: '重新载入',
  export: '导出文件',
} as const;

// 启动时打开上次的世界，连着两次没打开成（页面出了问题、被停下）：先问
export const OPEN_TWICE_TEXT = {
  title: '上次的世界前两次都没打开成',
  text: '它还存在这个浏览器里，没有丢。可以再试一次，或者先导出成世界文件。',
  textScripts: '它还存在这个浏览器里，没有丢。可以再试一次、不运行脚本打开，或者先导出成世界文件。',
  // 新建以后“留着的旧世界”里写的原因
  why: '连着两次没打开成',
} as const;
