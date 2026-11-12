import { CACHE_PREFIX, type Files, META_CACHE, PAGE, PAGE_WAIT_MS, type Precache, afterActivate, cacheName, filesOf, pageUsable, readPrecache, readVersions, route } from './offline/sw-core';

// service worker（第一百零一轮）：打开过一次以后，断网、服务器关了也能打开这个页面。这里只接线，规则都在 offline/sw-core.ts。
// 打包时 tools/offline-plugin.ts 把它打成一个文件 dist/sw.js，第一行是这一次打包的清单（self.__MAP2_PRECACHE）。
//   装：把壳（程序的全部文件，字体除外）存进这一版自己的缓存，每个文件的内容和清单里的 sha256 对得上才存；装不全这一次不算，下次再装。
//   启用：记下这一版，删掉更早的缓存（留着上一版：还开着的旧页面要用）。新的一版装好以后**等着**，不自己顶掉正在用的那一版——
//         页面说“现在启用”（用户点了“重新载入”，或者页面本来就是新的一版）才启用。
//   请求：刷新、打开先问网络、问不到给存下的；程序的文件先看存下的；别的不管。
// 计算 Worker 是从 data: 地址开的，它不归这里管（它本来也不联网）

const sw = self as unknown as ServiceWorkerGlobalScope;
const pre: Precache | null = readPrecache((self as unknown as { __MAP2_PRECACHE?: unknown }).__MAP2_PRECACHE);
const files: Files = pre ? filesOf(pre) : { shell: new Set(), lazy: new Set() };
const scope = sw.registration.scope;
const OWN = pre ? cacheName(pre.version) : '';
const at = (path: string) => scope + path;
// 记着的两样各占一个位置（两版同时写时不互相盖）
const META_ACTIVATED = at('__map2-offline/activated');
const META_PENDING = at('__map2-offline/pending');

async function metaGet(key: string): Promise<unknown> {
  try {
    const hit = await (await caches.open(META_CACHE)).match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}
async function metaPut(key: string, value: unknown): Promise<void> {
  await (await caches.open(META_CACHE)).put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 内容和清单里记的一样才存（不一样：抛错）
async function putChecked(cache: Cache, path: string, res: Response, sums: Record<string, string>): Promise<void> {
  if ((await sha256(await res.clone().arrayBuffer())) !== sums[path]) throw new Error(`${path}: 和清单对不上`);
  await cache.put(at(path), res);
}

// 取一个文件存下。不走浏览器自己的缓存（装的是服务器上现在的那一份）
async function store(cache: Cache, path: string, sums: Record<string, string>): Promise<void> {
  const res = await fetch(at(path), { cache: 'reload' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  await putChecked(cache, path, res, sums);
}

// 一次几个地做（不一下子全发出去）
async function eachOf(list: readonly string[], n: number, f: (path: string) => Promise<void>): Promise<void> {
  let k = 0;
  const next = async (): Promise<void> => {
    while (k < list.length) await f(list[k++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, next));
}

async function install(p: Precache): Promise<void> {
  await metaPut(META_PENDING, p.version).catch(() => {});
  const cache = await caches.open(OWN);
  try {
    await eachOf(p.shell, 4, (path) => store(cache, path, p.sums));
  } catch (e) {
    // 没存全：这一次不算（留着半份的话，断网时会打开一个缺文件的页面）
    await caches.delete(OWN).catch(() => {});
    throw e;
  }
}

async function activate(p: Precache): Promise<void> {
  const pending = await metaGet(META_PENDING);
  const plan = afterActivate(readVersions(await metaGet(META_ACTIVATED)), p.version, typeof pending === 'string' && pending !== p.version ? pending : null, await caches.keys());
  await metaPut(META_ACTIVATED, plan.activated).catch(() => {});
  if (pending === p.version) await metaPut(META_PENDING, null).catch(() => {});
  await Promise.all(plan.drop.map((n) => caches.delete(n).catch(() => false)));
  // 第一次装好时页面还不归它管：接过来，这一次打开页面用到的字体也就存得下
  await sw.clients.claim();
}

// 别的版本存下的同名文件（只给名字带内容哈希的用）
async function fromOthers(url: string): Promise<Response | undefined> {
  for (const name of await caches.keys()) {
    if (name === OWN || !name.startsWith(CACHE_PREFIX)) continue;
    const hit = await (await caches.open(name)).match(url);
    if (hit) return hit;
  }
  return undefined;
}

async function page(req: Request): Promise<Response> {
  let res: Response | null = null;
  try {
    res = await Promise.race([fetch(req), new Promise<null>((r) => setTimeout(() => r(null), PAGE_WAIT_MS))]);
    if (res && pageUsable(res)) return res;
  } catch {
    // 没有网、服务器关了
  }
  const cached = await (await caches.open(OWN)).match(at(PAGE));
  return cached ?? res ?? fetch(req);
}

async function file(ev: FetchEvent, r: { path: string; mine: boolean; shared: boolean }, sums: Record<string, string>): Promise<Response> {
  const url = at(r.path);
  const own = r.mine ? await caches.open(OWN) : null;
  const mine = await own?.match(url);
  if (mine) return mine;
  const old = r.shared ? await fromOthers(url) : undefined;
  if (old) {
    if (own) ev.waitUntil(own.put(url, old.clone()).catch(() => {}));
    return old;
  }
  const res = await fetch(ev.request);
  if (own && res.ok && res.type === 'basic') ev.waitUntil(putChecked(own, r.path, res.clone(), sums).catch(() => {}));
  return res;
}

// 把还没存的字体补齐：先看别的版本存过没有，没有再一个一个地取；取不到（断网了）就停，下次打开页面再接着补
async function fill(p: Precache): Promise<void> {
  const cache = await caches.open(OWN);
  try {
    await eachOf(p.lazy, 2, async (path) => {
      const url = at(path);
      if (await cache.match(url)) return;
      const old = await fromOthers(url);
      if (old) {
        await cache.put(url, old);
        return;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      await putChecked(cache, path, res, p.sums);
    });
  } catch {
    // 下次再补
  }
}

if (pre) {
  const p = pre;
  sw.addEventListener('install', (ev) => ev.waitUntil(install(p)));
  sw.addEventListener('activate', (ev) => ev.waitUntil(activate(p)));
  sw.addEventListener('fetch', (ev) => {
    const r = route({ method: ev.request.method, url: ev.request.url, mode: ev.request.mode }, scope, files);
    if (r.kind === 'pass') return;
    ev.respondWith(r.kind === 'page' ? page(ev.request) : file(ev, r, p.sums));
  });
  sw.addEventListener('message', (ev) => {
    const type = (ev.data as { type?: unknown } | null)?.type;
    if (type === 'skip-waiting') void sw.skipWaiting();
    else if (type === 'info') ev.ports[0]?.postMessage({ version: p.version, shell: p.shell });
    else if (type === 'fill') ev.waitUntil(fill(p));
  });
}
