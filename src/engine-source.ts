import engineUrl from './worker.ts?worker&url';

// 计算 Worker 的代码从哪里来（隔离那一步）：
//   打包好的程序：Vite 单独打包的那个文件（不引用别的模块），取它的文字做成 data: 地址；
//   开发时：开发服务器的 /__map2/engine.js（vite.config.ts 里的插件现打包一份），开发时也隔离。
// 取不到就用 engineUrl 开普通的 Worker（见 engine-spawn.ts）
export { engineUrl };

// 检查点的版本号：打包好的程序里是引擎文件的完整地址（文件名带内容哈希，代码一变就不同，与以前 Worker 里的
// import.meta.url 一样）；开发时文件名不变，没有版本号，不写检查点
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
