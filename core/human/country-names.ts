import { type GenName, type StyleBody, forbidden, hasType, isPhonetic, makeRoot, readOrig, styleName, transliterate } from '../name-styles';
import { mixSeed, mulberry32 } from '../rng';

// 国名的地名部分与人名（第二十三轮）：按文化的地名风格起。
// 风格里写了 country（国名的地名部分）、person（人名）两类时用它们；没写时：
//   音译式——拼一个词根（国名、人名都是），原文首字母大写，中文是音译；
//   模板式——国名用 region 的写法（避开“地区、之地”这类通称），人名从词表里取两个词

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// 模板式的 region 里不适合接称号的结尾
// 以“国”结尾的地名接上称号会成“X国王国”
const BAD_TAIL = ['地区', '之地', '地方', '道', '一带', '国'];

// 国名的地名部分（taken 里已有的中文名字避开）
export function countryBase(style: StyleBody, seed: number, taken?: Set<string>): GenName {
  if (hasType(style, 'country')) return styleName(style, 'country', [], seed, taken);
  let last: GenName = { zh: '' };
  for (let attempt = 0; attempt < 12; attempt++) {
    const s = mixSeed(seed, attempt, 0xc0);
    let name: GenName;
    if (isPhonetic(style)) {
      const root = makeRoot(style, mulberry32(s));
      name = { zh: transliterate(style, root), orig: cap(root) };
      if (!name.zh || forbidden(style, root)) continue;
    } else {
      name = styleName(style, hasType(style, 'region') ? 'region' : 'province', [], s);
      if (BAD_TAIL.some((t) => name.zh.endsWith(t)) && attempt < 11) continue;
    }
    last = name;
    if (!taken || !taken.has(name.zh) || attempt === 11) break;
  }
  if (last.zh) taken?.add(last.zh);
  return last;
}

// 人名（统治者）
export function personName(style: StyleBody, seed: number): GenName {
  if (hasType(style, 'person')) return styleName(style, 'person', [], seed);
  const rand = mulberry32(mixSeed(seed, 0x9e11));
  if (isPhonetic(style)) {
    for (let t = 0; t < 8; t++) {
      const root = makeRoot(style, rand);
      const zh = transliterate(style, root);
      if (zh && !forbidden(style, root)) return { zh, orig: cap(root) };
    }
    return { zh: '' };
  }
  // 模板式：从词表里取两个词（只取一两个字的词）
  const keys = Object.keys(style.lists).sort();
  const word = () => {
    for (let t = 0; t < 8; t++) {
      const list = style.lists[keys[Math.floor(rand() * keys.length)]];
      const w = list[Math.floor(rand() * list.length)];
      if (w && w.length <= 2) return w;
    }
    return '';
  };
  const zh = (word() + word()).slice(0, 4);
  const orig = readOrig(style.readings, zh);
  return orig ? { zh, orig } : { zh };
}
