// 离线（第一百零一轮）：service worker 的规则。都是纯函数——哪个请求怎么答、清单怎么认、旧的缓存留哪几份；
// src/sw.ts 只接线（装、启用、答请求），页面那一头在 src/offline/register.ts。设计见 docs/dev/history/第101轮.md。
// 这个文件要打进 sw.js（一个不引用别的模块的文件）：不引用界面、状态、引擎

// 打包时写进 sw.js 第一行的清单（tools/offline-plugin.ts 生成）
export interface Precache {
  // 这一次打包的版本：全部文件的内容算出来的，内容一样版本就一样
  version: string;
  // 程序的壳：装的时候全部存下，少一个就不算装好
  shell: string[];
  // 慢慢补的（字体的小文件）：用到时存，装好以后在后台补齐
  lazy: string[];
  // 上面每一个文件内容的 sha256：存下之前都核对。对不上的不存——正好撞上重新打包、服务器拿别的东西顶替了没有的文件
  // （vite preview 找不到文件时给的是 index.html）时，不会把错的内容当成程序存下来；壳里有一个对不上，这一次就不算装好
  sums: Record<string, string>;
}

// 清单在 sw.js 里是这样一行（冒烟的第十六段照这个格式换一份“新版本”）
export const PRECACHE_HEAD = 'self.__MAP2_PRECACHE=';
export const precacheLine = (p: Precache): string => `${PRECACHE_HEAD}${JSON.stringify(p)};\n`;

// 认一份清单：形状不对时 null（sw.js 被别的东西换掉了、手改坏了）
export function readPrecache(v: unknown): Precache | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  const paths = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length > 0 && !x.startsWith('/') && !x.includes('..'));
  if (typeof p.version !== 'string' || !/^[0-9a-z]{6,64}$/.test(p.version)) return null;
  if (!paths(p.shell) || !paths(p.lazy) || !p.shell.includes(PAGE)) return null;
  const sums = p.sums;
  if (sums === null || typeof sums !== 'object' || Array.isArray(sums)) return null;
  const table = sums as Record<string, unknown>;
  for (const f of [...p.shell, ...p.lazy]) if (typeof table[f] !== 'string' || !/^[0-9a-f]{64}$/.test(table[f] as string)) return null;
  return { version: p.version, shell: p.shell, lazy: p.lazy, sums: table as Record<string, string> };
}

// 页面的文件（刷新、打开时给的就是它）
export const PAGE = 'index.html';
// 每一次打包一份缓存，名字带版本
export const CACHE_PREFIX = 'map2-sw-';
export const cacheName = (version: string): string => CACHE_PREFIX + version;
// 记着启用过哪几版、正在装哪一版的那一份（很小；名字不带上面的前缀，清理时碰不到它）
export const META_CACHE = 'map2-offline-meta';
// 留几版：现在的一版和上一版。上一版留着，是给还开着没重新载入的旧页面用的（它还会要旧名字的文件）
export const KEEP_VERSIONS = 2;
// 刷新、打开时先问网络，等这么久没有回音就给存下的那一份（毫秒）
export const PAGE_WAIT_MS = 3000;
// 名字里带内容哈希的文件都在这个目录下（Vite 的 assets）：名字一样内容就一样，别的版本存过的可以拿来用
export const HASHED_DIR = 'assets/';

export type Route =
  // 不管：浏览器照平常的办
  | { kind: 'pass' }
  // 刷新、打开这个页面：先问网络（服务器开着就用它的：更新过的、开发服务器的都是它），问不到给存下的 index.html
  | { kind: 'page' }
  // 程序的一个文件：先看存下的。mine：这一版清单里的（没存过的存下）；不是的只看以前的版本存过没有，不存
  // shared：别的版本存下的同名文件也能用（名字带内容哈希的）
  | { kind: 'file'; path: string; mine: boolean; shared: boolean };

export interface Asked {
  method: string;
  url: string;
  // Request.mode：'navigate' 是刷新、打开、点链接
  mode: string;
}

// 清单里的路径 → 查得快的两个集合
export interface Files {
  shell: ReadonlySet<string>;
  lazy: ReadonlySet<string>;
}
export const filesOf = (p: Precache): Files => ({ shell: new Set(p.shell), lazy: new Set(p.lazy) });

// 一个请求怎么答。scope：service worker 管的那一段地址（registration.scope，以 / 结尾）
export function route(req: Asked, scope: string, files: Files): Route {
  const pass: Route = { kind: 'pass' };
  // 只管读：POST 这些不拦
  if (req.method !== 'GET') return pass;
  let url: URL;
  let base: URL;
  try {
    url = new URL(req.url);
    base = new URL(scope);
  } catch {
    return pass;
  }
  // 别的网站的、这一段地址以外的不拦
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return pass;
  const path = url.pathname.slice(base.pathname.length);
  if (req.mode === 'navigate') return path === '' || path === PAGE ? { kind: 'page' } : pass;
  // 带着 ? 的不是程序自己要的文件
  if (url.search !== '') return pass;
  if (files.shell.has(path)) return { kind: 'file', path, mine: true, shared: false };
  if (files.lazy.has(path)) return { kind: 'file', path, mine: true, shared: true };
  // 旧页面要的旧名字的文件：上一版存过就给，没存过照平常的问网络
  if (path.startsWith(HASHED_DIR)) return { kind: 'file', path, mine: false, shared: true };
  return pass;
}

// 网络给的页面能不能用：正常的回答、服务器让转去别处的（照转）能用；出错的（404、502……）不用，给存下的
export const pageUsable = (res: { ok: boolean; type: string }): boolean => res.ok || res.type === 'opaqueredirect';

// 启用这一版之后：记着的“启用过的版本”怎么改、哪几份缓存删掉。
// activated：以前启用过的（旧的在前）；pending：别的一版正在装（它的缓存还没存全，不能删）；names：现在有的缓存
export function afterActivate(activated: readonly string[], current: string, pending: string | null, names: readonly string[]): { activated: string[]; drop: string[] } {
  const next = [...activated.filter((v) => v !== current), current].slice(-KEEP_VERSIONS);
  const keep = new Set(next.map(cacheName));
  if (pending) keep.add(cacheName(pending));
  return { activated: next, drop: names.filter((n) => n.startsWith(CACHE_PREFIX) && !keep.has(n)) };
}

// 记着的那一份读出来的样子不对时当作没有
export function readVersions(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// ---------- 页面那一头 ----------

// 页面发给 service worker 的话
export type ToSw =
  // 问它是哪一版、壳里有哪些文件（用 MessageChannel 的那一头回）
  | { type: 'info' }
  // 等着的新版本：现在启用
  | { type: 'skip-waiting' }
  // 把还没存的字体在后台补齐
  | { type: 'fill' };
export interface SwInfo {
  version: string;
  shell: string[];
}
export function readInfo(v: unknown): SwInfo | null {
  if (v === null || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (typeof m.version !== 'string' || !Array.isArray(m.shell) || !m.shell.every((x) => typeof x === 'string')) return null;
  return { version: m.version, shell: m.shell as string[] };
}

// 这个页面是不是那一版打包出来的：页面上程序的脚本（index.html 里写着的那几个）都在那一版的壳里。
// 是的话新版本可以马上启用（页面已经是新的，没有东西会被换掉）；不是就等用户点“重新载入”
export function pageIsFrom(scripts: readonly string[], scope: string, shell: readonly string[]): boolean {
  let base: URL;
  try {
    base = new URL(scope);
  } catch {
    return false;
  }
  const have = new Set(shell);
  let n = 0;
  for (const s of scripts) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return false;
    }
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return false;
    if (!have.has(u.pathname.slice(base.pathname.length))) return false;
    n++;
  }
  return n > 0;
}

// 在哪里登记：只在打包好的程序、http(s) 下（开发服务器、测试、file:// 都不登记）
export function canRegister(env: { prod: boolean; protocol: string; hasSw: boolean }): boolean {
  return env.prod && env.hasSw && (env.protocol === 'http:' || env.protocol === 'https:');
}
