import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, type PhoneticStyle, forbidden, nameStyleSchema, sampleNames, styleFor, styleName, styleNotes, styleProblems } from './name-styles';
import { hashString } from './names';
import { BUILTIN_STYLES } from './packs/names';

// 第二十轮：内置的每一种地名风格——格式、问题、确定性、每类地物都起得出名字、原文、重名、
// 起出来的名字不碰上自己的“不许的写法”（碰上了说明模板里照抄的字被禁了，每次都要重试到底）

const TYPES = ['continent', 'island', 'archipelago', 'peninsula', 'ocean', 'sea', 'bay', 'strait', 'lake', 'river', 'range', 'peak', 'plateau', 'plain', 'basin', 'desert', 'forest', 'tundra', 'icecap', 'wetland', 'biome', 'province', 'region', 'spot'];
const PROVINCE_TAGS = ['coastal', 'river', 'mountain', 'sea', 'waste'];
// 以前就有的两种不要求省份的情境写全
const OLD = new Set(['zh-default', 'ja-kanji']);
const ZH = /^[一-鿿·]+$/u;
const ORIG = /^[\p{L}][\p{L}'’ -]*$/u;

const hasOrig = (id: string) => BUILTIN_STYLES.find((s) => s.id === id)!.kind === 'phonetic' || id === 'ja-kanji' || id === 'ko-hanja';

describe('内置的地名风格：每一种', () => {
  it('格式合格、id 与名字不重复、名字是“地区·语言”、有说明', () => {
    const ids = BUILTIN_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BUILTIN_STYLES.map((s) => s.name)).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(25);
    for (const s of BUILTIN_STYLES) {
      expect(nameStyleSchema.parse(JSON.parse(JSON.stringify(s))), s.id).toEqual(s);
      expect(styleProblems(s), s.id).toEqual([]);
      expect(styleNotes(s), s.id).toEqual([]);
      expect(s.name, s.id).toMatch(/^[一-鿿]+·[一-鿿]+$/u);
      expect(s.description?.length ?? 0, s.id).toBeGreaterThan(10);
    }
  });

  it('每类地物都写了；新的风格省份有海边、河边、山里、海、荒地几个情境', () => {
    for (const s of BUILTIN_STYLES) {
      for (const t of TYPES) expect(s.types[t], `${s.id} ${t}`).toBeDefined();
      if (OLD.has(s.id)) continue;
      for (const tag of PROVINCE_TAGS) expect(s.types.province.byTag?.[tag], `${s.id} province/${tag}`).toBeDefined();
    }
  });

  it('同一个种子同一个名字；每类地物都起得出中文名，音译式和带读音表的都有原文', () => {
    for (const s of BUILTIN_STYLES) {
      for (const t of TYPES) {
        for (let k = 0; k < 12; k++) {
          const seed = hashString(`b:${s.id}:${t}:${k}`);
          const tags = k % 3 === 0 ? [] : k % 3 === 1 ? ['coastal', 'cold'] : ['river', 'volcanic', 'small'];
          const a = styleName(s, t, tags, seed, undefined, '草原');
          expect(styleName(s, t, tags, seed, undefined, '草原'), `${s.id} ${t}`).toEqual(a);
          expect(a.zh, `${s.id} ${t} ${a.orig}`).toMatch(ZH);
          expect(a.zh.length, `${s.id} ${t} ${a.zh}`).toBeLessThanOrEqual(16);
          // 生态区的名字里有中文的生态名，模板式读不出原文
          if (!hasOrig(s.id) || (t === 'biome' && s.kind === 'template')) continue;
          expect(a.orig, `${s.id} ${t} ${a.zh}`).toMatch(ORIG);
          expect(a.orig, `${s.id} ${t}`).toMatch(/\p{Lu}/u);
        }
      }
    }
  });

  it('起出来的名字不碰上自己的不许的写法', () => {
    for (const s of BUILTIN_STYLES) {
      if (s.kind !== 'phonetic') continue;
      let bad = 0;
      let total = 0;
      for (const t of TYPES) {
        for (const tags of [[], ['coastal'], ['river'], ['mountain'], ['sea'], ['waste'], ['cold'], ['volcanic'], ['small'], ['dry']]) {
          for (let k = 0; k < 6; k++) {
            const n = styleName(s, t, tags, hashString(`f:${s.id}:${t}:${tags.join()}:${k}`));
            total++;
            if (forbidden(s as PhoneticStyle, n.orig ?? '')) bad++;
          }
        }
      }
      expect(bad / total, s.id).toBeLessThan(0.01);
    }
  });

  it('重名少：200 个里不避重名时重复不到一成多，避重名时几乎没有', () => {
    for (const s of BUILTIN_STYLES) {
      for (const t of ['island', 'province', 'river', 'lake', 'peak']) {
        const seen = new Set<string>();
        for (let k = 0; k < 200; k++) seen.add(styleName(s, t, [], hashString(`d:${s.id}:${t}:${k}`)).zh);
        if (!OLD.has(s.id)) expect(seen.size, `${s.id} ${t}`).toBeGreaterThanOrEqual(170);
        const avoided = new Set(sampleNames(s, t, 200).map((n) => n.zh));
        expect(avoided.size, `${s.id} ${t}`).toBeGreaterThanOrEqual(196);
      }
    }
  });

  it('没选风格的世界用世界里第一种（新世界默认加进来的中文·默认）；一种都没有时不起名', () => {
    expect(DEFAULT_STYLE).toBe('zh-default');
    expect(BUILTIN_STYLES[0].id).toBe(DEFAULT_STYLE);
    expect(styleFor({ small: { featureNames: {}, provinces: {}, content: { nameStyle: { [DEFAULT_STYLE]: BUILTIN_STYLES[0] } } } as never }).id).toBe(DEFAULT_STYLE);
    expect(styleFor({ small: { featureNames: {}, provinces: {} } as never }).id).toBe('');
  });
});
