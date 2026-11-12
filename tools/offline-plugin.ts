import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Plugin, build } from 'vite';

// 离线（第一百零一轮）：打包的最后一步生成 dist/sw.js（service worker）和第三方许可证的那一份。
//   - sw.js = 一行清单 + src/sw.ts 打成的一个文件（不引用别的模块）。清单是把 dist/ 走一遍得到的：
//     壳（程序的全部文件，装的时候都存下）、慢慢补的（字体的小文件）、这一次打包的版本（全部文件的内容算出来的，
//     内容一样版本就一样：没改代码重新打包，浏览器不会说“有新版本”）、每个文件内容的 sha256（存下之前核对）。
//   - THIRD-PARTY-LICENSES.txt：打进程序的库和字体各自的许可证原文（MIT、ISC 要求带着版权声明，OFL 要求随字体带许可证）。
// 只在 vite build 时起作用；开发服务器、测试里没有 service worker。
// 清单那一行的写法同 src/offline/sw-core.ts 的 PRECACHE_HEAD（这里不引用 src/：见 isolated-engine.ts 里同样的说明；测试查两边相同）

export const PRECACHE_HEAD = 'self.__MAP2_PRECACHE=';
export const SW_FILE = 'sw.js';
export const LICENSES_FILE = 'THIRD-PARTY-LICENSES.txt';
export const PAGE = 'index.html';

export interface Precache {
  version: string;
  shell: string[];
  lazy: string[];
  sums: Record<string, string>;
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

// 字体的小文件：不在装的时候存（97 个、约 4.6 MB），用到时存、装好以后在后台补齐
const isLazy = (path: string) => /\.woff2?$/.test(path);
// 不进清单的：service worker 自己、点开头的（一键开启记的源码哈希、系统的 .DS_Store）
const skipped = (path: string) => path === SW_FILE || path.split('/').some((seg) => seg.startsWith('.'));

// dist/ 里的文件（路径、内容的 sha256）→ 清单。swCode：service worker 的代码（它变了也算新版本）
export function precacheOf(entries: readonly { path: string; sha: string }[], swCode: string): Precache {
  const list = entries.filter((e) => !skipped(e.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!list.some((e) => e.path === PAGE)) throw new Error('dist/ 里没有 index.html');
  const h = createHash('sha256');
  for (const e of list) h.update(`${e.path}\0${e.sha}\n`);
  h.update(sha256(swCode));
  return {
    version: h.digest('hex').slice(0, 16),
    shell: list.filter((e) => !isLazy(e.path)).map((e) => e.path),
    lazy: list.filter((e) => isLazy(e.path)).map((e) => e.path),
    sums: Object.fromEntries(list.map((e) => [e.path, e.sha])),
  };
}

export const swFile = (p: Precache, swCode: string): string => `${PRECACHE_HEAD}${JSON.stringify(p)};\n${swCode}`;

// 一个目录下的全部文件（相对的路径，/ 分隔）
export function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, `${prefix}${name}/`));
    else out.push(prefix + name);
  }
  return out;
}

// 把 src/sw.ts 连同它引用的打成一个文件（普通的脚本，不是模块）
export async function bundleSw(root: string): Promise<string> {
  const out = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      copyPublicDir: false,
      emptyOutDir: false,
      reportCompressedSize: false,
      lib: { entry: resolve(root, 'src/sw.ts'), formats: ['iife'], name: 'map2sw', fileName: 'sw' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const chunks = outputs.flatMap((o) => ('output' in o ? o.output : [])).filter((c) => c.type === 'chunk');
  if (chunks.length !== 1) throw new Error(`service worker 应当打包成一个文件，实际是 ${chunks.length} 个`);
  return chunks[0].code;
}

// 打进程序的库（package.json 的 dependencies 和它们各自依赖的）：名字、版本、许可证、许可证的原文
export interface ThirdParty {
  name: string;
  version: string;
  license: string;
  texts: { file: string; text: string }[];
}
export function thirdParty(root: string): ThirdParty[] {
  const pkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string; license?: string; dependencies?: Record<string, string> };
  const seen = new Map<string, ThirdParty>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    const dir = join(root, 'node_modules', name);
    if (!existsSync(join(dir, 'package.json'))) return;
    const p = pkg(dir);
    const texts = readdirSync(dir)
      .filter((f) => /^(licen[sc]e|copying|notice|ofl)(\.|$)/i.test(f))
      .sort()
      .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8').trim() }));
    seen.set(name, { name, version: p.version ?? '', license: p.license ?? '', texts });
    for (const d of Object.keys(p.dependencies ?? {})) visit(d);
  };
  for (const d of Object.keys(pkg(root).dependencies ?? {})) visit(d);
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}
export function licensesText(list: readonly ThirdParty[]): string {
  const line = '='.repeat(72);
  const head = ['这个程序里带着下面这些第三方的库和字体，各自的许可证原文照录。', '程序本身的许可证见仓库根目录的 LICENSE（MIT）。', ''];
  const body = list.flatMap((t) => [line, `${t.name} ${t.version}（${t.license}）`, line, '', ...t.texts.flatMap((x) => [`--- ${x.file} ---`, '', x.text, '']), '']);
  return `${[...head, ...body].join('\n').trimEnd()}\n`;
}

export function offlineFiles(root: string): Plugin {
  let outDir = '';
  let on = false;
  return {
    name: 'map2-offline',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      // 只管整个程序的那一次打包（不是打一个库、不是只在内存里打）
      on = config.build.write !== false && !config.build.lib && !config.build.ssr;
    },
    generateBundle() {
      if (!on) return;
      this.emitFile({ type: 'asset', fileName: LICENSES_FILE, source: licensesText(thirdParty(root)) });
    },
    closeBundle: {
      sequential: true,
      order: 'post',
      async handler() {
        // 打包没成功（没有页面）时不写
        if (!on || !existsSync(join(outDir, PAGE))) return;
        const code = await bundleSw(root);
        const entries = listFiles(outDir).map((path) => ({ path, sha: sha256(readFileSync(join(outDir, path))) }));
        writeFileSync(join(outDir, SW_FILE), swFile(precacheOf(entries, code), code));
      },
    },
  };
}
