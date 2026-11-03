// 一次性工具（第五十三轮，已经跑过，不用再跑）：把内置政体、派系改写成“政体列派系、派系有基础分量”。
//   node tools/rewrite-factions.mjs            照第五十二轮（bcf2c05）的 JSON 算一遍，写进 core/packs/
//   node tools/rewrite-factions.mjs --check    只比较：算出来的和仓库里的逐字节相同时退出码 0
//   加 --table 把每个政体的名单打印出来
// 输入总是 bcf2c05 里的文件（git show），所以跑几遍都一样。第五十三轮之后手改过内置 JSON，--check 就会不同，这是正常的。
//
// 规则（设计见 docs/dev/history/第53轮.md）：
//   派系“点名”这个政体：base 里写了这个政体的某个类别，比 default 大，并且 ≥ 0.4 或 ≥ default 的 3 倍（基础太小的不算点名）。
//   派系“靠人口驱动”：base 里只有 default，有 drivers（中世纪的异教臣民）。
//   政体在几个库里时（比如专制君主在青铜、中世纪、近现代）名单只有一份，每个库都要找得到：
//     先从这几个库都有的派系里选；都有的不到两个时，从政体最早的库（HOME 另写的除外）的派系里选点名的，再把选中的加进别的库。
//     靠人口驱动的只从这几个库都有的里选。
//   名单不到两个时，从能选的派系里按旧的基础影响力从大到小补（一样大时按库里的先后）。
//   名单的先后按库里派系的先后。
//   基础分量 amount = 列着它的政体上，旧的基础影响力的平均（两位小数）；哪个政体都没列时是 default。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = 'bcf2c05';
const ERAS = ['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi'];
// 技术官僚制在现代、科幻两个库：现代没有点名寡头的派系，科幻的财团、科学院才是它的人
const HOME = { technocracy: 'scifi' };

const old = (path) => execFileSync('git', ['show', `${FROM}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const govPath = (e) => `core/packs/governments/${e}.json`;
const eraPath = (e) => `core/packs/eras/${e}.json`;

const govText = new Map(ERAS.map((e) => [e, old(govPath(e))]));
const eraText = new Map(ERAS.map((e) => [e, old(eraPath(e))]));
const packs = new Map(ERAS.map((e) => [e, JSON.parse(eraText.get(e)).pack]));
const govs = new Map();
const facs = new Map();
for (const e of ERAS) {
  const d = JSON.parse(govText.get(e));
  for (const g of d.governments ?? []) if (!govs.has(g.id)) govs.set(g.id, g);
  for (const f of d.factions ?? []) if (!facs.has(f.id)) facs.set(f.id, f);
}

// 旧的基础影响力（country-layers.ts 的 baseOf）：政体的类别里写了的取平均，一个都没写时用 default
function baseOf(f, cats) {
  const hits = cats.map((c) => f.base[c]).filter((v) => v !== undefined);
  return hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : (f.base.default ?? 0);
}
function named(f, g) {
  const d = f.base.default ?? 0;
  return g.category.some((c) => {
    const v = f.base[c];
    return v !== undefined && v > d && (v >= 0.4 || v >= 3 * d);
  });
}
const popDriven = (f) => !!f.drivers?.length && Object.keys(f.base).every((k) => k === 'default');

const lists = new Map();
const added = new Map(ERAS.map((e) => [e, []]));
for (const g of govs.values()) {
  const libs = ERAS.filter((e) => packs.get(e).governments.includes(g.id));
  if (!libs.length) throw new Error(`政体 ${g.id} 不在哪个库里`);
  const first = packs.get(libs[0]).factions;
  const common = first.filter((id) => libs.every((e) => packs.get(e).factions.includes(id)));
  const home = HOME[g.id] && libs.includes(HOME[g.id]) ? HOME[g.id] : libs[0];
  const pool = common.length >= 2 ? common : packs.get(home).factions;
  const list = pool.filter((id) => named(facs.get(id), g) || (common.includes(id) && popDriven(facs.get(id))));
  const rest = pool.filter((id) => !list.includes(id)).sort((a, b) => baseOf(facs.get(b), g.category) - baseOf(facs.get(a), g.category) || pool.indexOf(a) - pool.indexOf(b));
  while (list.length < 2 && rest.length) list.push(rest.shift());
  if (list.length < 2) throw new Error(`政体 ${g.id} 不到两个派系`);
  list.sort((a, b) => pool.indexOf(a) - pool.indexOf(b));
  lists.set(g.id, list);
  for (const e of libs) for (const id of list) if (!packs.get(e).factions.includes(id) && !added.get(e).includes(id)) added.get(e).push(id);
}

// 基础分量
const amounts = new Map();
for (const f of facs.values()) {
  const vals = [...lists].filter(([, l]) => l.includes(f.id)).map(([id]) => baseOf(f, govs.get(id).category));
  amounts.set(f.id, vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : (f.base.default ?? 0));
}

const inline = (list) => `[${list.map((x) => JSON.stringify(x)).join(', ')}]`;
const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

function rewriteGovFile(text) {
  let out = text;
  const own = new Set((JSON.parse(text).governments ?? []).map((g) => g.id));
  for (const [id, list] of lists) {
    const re = new RegExp(`("id": "${esc(id)}",\\n(?:[^\\n]*\\n)*?)( *)("category": \\[[^\\]]*\\],\\n)`);
    if (!own.has(id)) continue;
    const next = out.replace(re, (_, a, sp, c) => `${a}${sp}${c}${sp}"factions": ${inline(list)},\n`);
    if (next === out) throw new Error(`没改到政体 ${id}`);
    out = next;
  }
  for (const f of JSON.parse(text).factions ?? []) {
    const re = new RegExp(`("id": "${esc(f.id)}",\\n(?:[^\\n]*\\n)*?)( *)"base": \\{[^}]*\\}`);
    const next = out.replace(re, (_, a, sp) => `${a}${sp}"amount": ${amounts.get(f.id)}`);
    if (next === out) throw new Error(`没改到派系 ${f.id}`);
    out = next;
    // 派系自己写的时代（只用来查“列在哪些库”）跟上
    const eras = ERAS.filter((e) => packs.get(e).factions.includes(f.id) || added.get(e).includes(f.id));
    const reEras = new RegExp(`("id": "${esc(f.id)}",\\n(?:[^\\n]*\\n)*?)( *)"eras": \\[[^\\]]*\\]`);
    const withEras = out.replace(reEras, (_, a, sp) => `${a}${sp}"eras": ${inline(eras)}`);
    if (!reEras.test(out)) throw new Error(`派系 ${f.id} 没写 eras`);
    out = withEras;
  }
  return out;
}

function rewriteEraFile(e, text) {
  const extra = added.get(e);
  if (!extra.length) return text;
  const re = /("factions": )\[[^\]]*\]/;
  if (!re.test(text)) throw new Error(`时代 ${e} 没有 factions`);
  return text.replace(re, (_, a) => `${a}${inline([...packs.get(e).factions, ...extra])}`);
}

const outputs = new Map();
for (const e of ERAS) {
  outputs.set(govPath(e), rewriteGovFile(govText.get(e)));
  outputs.set(eraPath(e), rewriteEraFile(e, eraText.get(e)));
}

if (process.argv.includes('--table')) {
  for (const [id, l] of lists) console.log(`${govs.get(id).name}（${id}，${govs.get(id).category.join('、')}）：${l.map((x) => facs.get(x).name).join('、')}`);
  console.log('');
  for (const [id, a] of amounts) console.log(`${facs.get(id).name}（${id}）：${a}`);
  console.log('');
  for (const [e, l] of added) if (l.length) console.log(`${e} 多带：${l.join('、')}`);
}

if (process.argv.includes('--check')) {
  const diff = [...outputs].filter(([p, t]) => readFileSync(join(ROOT, p), 'utf8') !== t).map(([p]) => p);
  if (diff.length) {
    console.error(`和仓库里的不同：\n${diff.join('\n')}`);
    process.exit(1);
  }
  console.log('逐字节相同');
} else {
  for (const [p, t] of outputs) writeFileSync(join(ROOT, p), t);
  console.log(`写了 ${outputs.size} 个文件`);
}
