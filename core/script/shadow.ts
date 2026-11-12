
// 被遮住的全局名字和一碰就报错的那几个（第一百零一轮从 core/script.ts 的“出错”一节原样搬来；单独一个文件：出错的说明和辅助函数都要用它，放在哪一边都会绕成圈）

// 被遮住的名字。脚本里它们大多是 undefined；POISONED 里的一碰就报错（出错提示能说清为什么），
// Math 是没有 random 的副本。后面几个（global 到 Atomics）不在计划的名单里，补上是因为它们会让结果随时间、
// 随电脑、随垃圾回收变化：navigator.hardwareConcurrency、Intl.DateTimeFormat().format()、Temporal.Now、WeakRef……
export const SHADOW = [
  'globalThis',
  'self',
  'window',
  'Function',
  'eval',
  'Date',
  'performance',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'importScripts',
  'postMessage',
  'indexedDB',
  'caches',
  'crypto',
  'Worker',
  'require',
  'process',
  'Math',
  'global',
  'navigator',
  'location',
  'Temporal',
  'Intl',
  'WeakRef',
  'FinalizationRegistry',
  'SharedArrayBuffer',
  'Atomics',
] as const;

// 一碰就报错的替身，以及报错时的提示
export const POISONED: Partial<Record<(typeof SHADOW)[number], string>> = {
  Date: '脚本里不能用时间',
  performance: '脚本里不能用时间',
  Temporal: '脚本里不能用时间',
  crypto: '用 rand() 代替 crypto 的随机数',
  Intl: '脚本里不能用 Intl',
};
