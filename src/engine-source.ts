import engineUrl from './worker.ts?worker&url';

// 计算 Worker 的代码从哪里来（隔离那一步）：
//   打包好的程序：Vite 单独打包的那个文件（不引用别的模块），取它的文字做成 data: 地址；
//   开发时：开发服务器的 /__map2/engine.js（vite.config.ts 里的插件现打包一份），开发时也隔离。
// 取不到就用 engineUrl 开普通的 Worker（见 engine-spawn.ts）
export { engineUrl };

// 检查点的版本号：打包好的程序里是引擎文件的完整地址（文件名带内容哈希，代码一变就不同，与以前 Worker 里的
// import.meta.url 一样）；开发时文件名不变，版本号改用引擎文件内容的哈希（见 buildKey），这里为 null
export const BUILD: string | null = import.meta.env.DEV ? null : new URL(engineUrl, location.href).href;

const DEV_ENGINE = `${import.meta.env.BASE_URL}__map2/engine.js`;

// 一个页面只取一次（取不到下次再试）
let code: Promise<string | null> | null = null;
export function engineCode(): Promise<string | null> {
  code ??= fetch(import.meta.env.DEV ? DEV_ENGINE : engineUrl, { cache: import.meta.env.DEV ? 'no-store' : 'default' })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null)
    .then((text) => {
      if (text === null) code = null;
      return text;
    });
  return code;
}

// 检查点的版本号（新建、打开之前取）：打包好的程序里就是 BUILD；开发时是计算 Worker 实际运行的引擎文件
// （/__map2/engine.js，改了 core/、src/ 就重新打包）的内容哈希，代码一变就不同，开发时检查点也能用。
// 取不到引擎文件（退回普通 Worker）时为 null：不读不写检查点
let devKey: Promise<string | null> | null = null;
export function buildKey(): Promise<string | null> {
  if (!import.meta.env.DEV) return Promise.resolve(BUILD);
  devKey ??= engineCode().then((text) => (text === null ? null : hashText(text)));
  return devKey.then((k) => {
    if (k === null) devKey = null;
    return k;
  });
}

async function hashText(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return `dev:${Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    // 没有 crypto.subtle（不安全的来源）：两路 32 位的乘法哈希
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x5bd1e995);
      h2 ^= h2 >>> 15;
    }
    return `dev:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}:${text.length}`;
  }
}
