import { describe, expect, it } from 'vitest';
import { DEFAULT_NAME_MODE, nameLines, nameText } from './name-display';
import { DEFAULT_STYLE, type NameStyle, type PhoneticStyle, forbidden, makeRoot, missingStyles, nameStyleSchema, phoneticName, readOrig, sampleNames, styleFor, styleName, styleNotes, styleProblems, templateName, transliterate, NO_STYLE, worldStyleId } from './name-styles';
import { generateName, hashString } from './names';
import { BUILTIN_STYLES } from './packs/names';
import { mulberry32 } from './rng';
import type { SmallState } from './world';
import { NAME_STYLES_SAMPLE, ZH_STYLE } from './testing/fixtures';

// 第二十轮：地名风格的两种写法（模板式、音译式）、音译表、读音表、确定性、一处地方用哪种风格、显示中文 / 原文 / 两者

const germanic = BUILTIN_STYLES.find((s) => s.id === 'west-germanic') as PhoneticStyle;
const japanese = BUILTIN_STYLES.find((s) => s.id === 'ja-kanji')!;
const TYPES = ['continent', 'island', 'archipelago', 'peninsula', 'ocean', 'sea', 'bay', 'strait', 'lake', 'river', 'range', 'peak', 'plateau', 'plain', 'basin', 'desert', 'forest', 'tundra', 'icecap', 'wetland', 'province', 'region', 'spot'];

describe('内置的地名风格', () => {
  it('都合格、没有问题；中文·默认就是以前的内置文字包（每一种的样子见 name-styles-builtin.test.ts）', () => {
    expect(BUILTIN_STYLES.slice(0, 3).map((s) => s.id)).toEqual(['zh-default', 'west-germanic', 'ja-kanji']);
    for (const s of BUILTIN_STYLES) {
      expect(styleProblems(s), s.id).toEqual([]);
      expect(styleNotes(s), s.id).toEqual([]);
      expect(nameStyleSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
    }
    // 中文·默认（第三十轮起是普通内容，测试里的 ZH_STYLE 就是它；文件就是以前的内置文字包，见 packs/names/zh-default.json）
    expect(BUILTIN_STYLES[0]).toBe(ZH_STYLE);
    expect(ZH_STYLE.kind).toBe('template');
    expect(NAME_STYLES_SAMPLE.nameStyles!.map((s) => s.id)).toEqual(BUILTIN_STYLES.slice(1).map((s) => s.id));
  });

  it('每种地物都起得出名字；音译式与带读音表的都有原文', () => {
    for (const type of TYPES) {
      for (const n of sampleNames(germanic, type, 8)) {
        expect(n.zh, type).toMatch(/^[一-鿿·]+$/);
        expect(n.orig, type).toMatch(/^[A-Z][a-zäöüß]+( [A-Za-zäöüß]+)*$/);
      }
      for (const n of sampleNames(japanese, type, 8)) {
        expect(n.zh.length, type).toBeGreaterThan(1);
        expect(n.orig, `${type} ${n.zh}`).toMatch(/^[A-Z][a-z]+([ -][A-Za-z]+)*$/);
      }
    }
  });
});

describe('模板式', () => {
  it('没有读音表：与以前的文字包一字不差，没有原文', () => {
    for (let k = 0; k < 50; k++) {
      const seed = hashString(`t:${k}`);
      const taken1 = new Set<string>();
      const taken2 = new Set<string>();
      expect(templateName(ZH_STYLE, 'island', ['cold'], seed, taken1)).toEqual({ zh: generateName(ZH_STYLE, 'island', ['cold'], seed, taken2) });
      expect([...taken1]).toEqual([...taken2]);
    }
  });

  it('读音表：最长匹配读出原文，读不全时没有', () => {
    const r = { 白: 'shira', 浜: 'hama', 島: 'shima', 白浜: 'shirahama-', 湖: '-ko', 大陸: ' Tairiku' };
    expect(readOrig(r, '白浜島')).toBe('Shirahama-shima');
    expect(readOrig(r, '浜白島')).toBe('Hamashirashima');
    expect(readOrig(r, '白湖')).toBe('Shira-ko');
    expect(readOrig(r, '白浜大陸')).toBe('Shirahama- Tairiku');
    expect(readOrig(r, '白川')).toBeUndefined();
    expect(readOrig(undefined, '白')).toBeUndefined();
    expect(templateName(japanese as never, 'island', [], 7).orig).toBeDefined();
  });
});

describe('音译式', () => {
  it('音译表：从左往右取最长的一段，辅音不和后面的元音拆开', () => {
    expect(transliterate(germanic, 'Karvilsburg')).toBe('卡尔维尔斯堡');
    // vilen：vil 后面是元音，辅音归后面 → vi·len
    expect(transliterate(germanic, 'Vilen')).toBe('维伦');
    expect(transliterate(germanic, 'Bergen')).toBe('贝尔根');
    expect(transliterate(germanic, 'Heim')).toBe('海姆');
    // 空格写成“·”，连字符略过
    expect(transliterate(germanic, 'Nor Kal')).toBe('诺尔·卡尔');
    expect(transliterate(germanic, 'Ka-ra')).toBe('卡拉');
    // 没有的字母：有 fallback 时写成它，没有时略过
    const t = { translit: { ka: '卡' } };
    expect(transliterate(t, 'kaq')).toBe('卡');
    expect(transliterate({ ...t, fallback: '？' }, 'kaq')).toBe('卡？');
  });

  it('不许的写法：任何地方、开头、结尾', () => {
    const s = { forbid: ['aa', '^ng', 'q$'] };
    expect([forbidden(s, 'Kaal'), forbidden(s, 'Ngor'), forbidden(s, 'Torq'), forbidden(s, 'Tong'), forbidden(s, 'qat')]).toEqual([true, true, true, false, false]);
    // 拼出来的词根里没有不许的写法
    const rand = mulberry32(3);
    for (let k = 0; k < 300; k++) expect(forbidden(germanic, makeRoot(germanic, rand))).toBe(false);
  });

  it('同一个种子同一个名字；种子不同名字多半不同；taken 里有的换一个', () => {
    const a = phoneticName(germanic, 'province', ['coastal'], 42);
    expect(phoneticName(germanic, 'province', ['coastal'], 42)).toEqual(a);
    const names = new Set(Array.from({ length: 60 }, (_, k) => phoneticName(germanic, 'island', [], k).zh));
    expect(names.size).toBeGreaterThan(50);
    const taken = new Set([a.zh]);
    const b = phoneticName(germanic, 'province', ['coastal'], 42, taken);
    expect(b.zh).not.toBe(a.zh);
    expect(taken.has(b.zh)).toBe(true);
  });

  it('写法：{root} 拼词根，{表名} 取词缀，中文写法里 {name} 是整个原文的音译、{root} 是那一段的', () => {
    const style: PhoneticStyle = {
      id: 't',
      name: '测试',
      kind: 'phonetic',
      syllables: { onsets: ['k'], nuclei: ['a'], codas: ['r'] },
      length: [[2, 1]],
      lists: { end: ['burg'] },
      types: { island: { patterns: [{ p: '{root}{end}', zh: '{name}岛' }] }, lake: { patterns: [{ p: '{root}see', zh: '{root}湖' }] }, biome: { patterns: [{ p: '{root}', zh: '{root}{__species}' }] } },
      translit: { ka: '卡', r: '尔', burg: '堡', se: '塞', e: '埃' },
    };
    expect(phoneticName(style, 'island', [], 1)).toEqual({ zh: '卡尔卡尔堡岛', orig: 'Karkarburg' });
    expect(phoneticName(style, 'lake', [], 1)).toEqual({ zh: '卡尔卡尔湖', orig: 'Karkarsee' });
    expect(phoneticName(style, 'biome', [], 1, undefined, '草原')).toEqual({ zh: '卡尔卡尔草原', orig: 'Karkar' });
    // 没有的类型按 default、island
    expect(phoneticName(style, 'river', [], 1).orig).toBe('Karkarburg');
    expect(styleName(style, 'island', [], 1)).toEqual(phoneticName(style, 'island', [], 1));
  });

  it('检查：写法里不存在的词表是问题（不能启用），音译表写不出的字母只提醒', () => {
    const bad: NameStyle = { ...germanic, types: { island: { patterns: [{ p: '{root}{nope}' }] } } };
    expect(styleProblems(bad)).toEqual(['“island”的写法“{root}{nope}”用到了不存在的词表 {nope}']);
    const gap: NameStyle = { ...germanic, translit: { a: '阿' } };
    expect(styleProblems(gap)).toEqual([]);
    expect(styleNotes(gap)[0]).toMatch(/^音译表里没有这些字母，音译时略过：/);
  });
});

describe('一处地方用哪种风格（styleFor）', () => {
  // 第三十轮：中文·默认也是世界里的普通内容（新建时默认加进来）
  const zh = { 'zh-default': ZH_STYLE };
  const small = (extra: Partial<SmallState> = {}) => ({ featureNames: {}, provinces: {}, content: { nameStyle: zh }, ...extra }) as unknown as SmallState;
  const content = { nameStyle: { ...zh, 'west-germanic': germanic } };

  it('什么都没选：世界里第一种（中文·默认），种子不加；一种都没有时不起名', () => {
    const r = styleFor({ small: small() }, { feature: { key: 'island:3' } });
    expect([r.id, r.suffix, r.style]).toEqual([DEFAULT_STYLE, '', ZH_STYLE]);
    expect(r.tag).not.toBe('-');
    // 换了中文·默认的内容：内容是它，标识跟着变
    const wp = { ...ZH_STYLE, lists: { ...ZH_STYLE.lists, extra: ['甲'] } };
    const r2 = styleFor({ small: small({ content: { nameStyle: { 'zh-default': wp } } }) });
    expect([r2.id, r2.style, r2.suffix]).toEqual([DEFAULT_STYLE, wp, '']);
    expect(r2.tag).not.toBe(r.tag);
    // 一种都没有：NO_STYLE，名字是空的
    const none = styleFor({ small: small({ content: {} }) });
    expect([none.id, none.style, none.suffix, none.tag]).toEqual(['', NO_STYLE, '', '-']);
    expect(worldStyleId(small({ content: {} }))).toBe('');
    expect(styleName(NO_STYLE, 'island', [], 1).zh).toBe('');
  });

  it('世界默认 → 自己选的；选的不在世界里时按世界默认', () => {
    const s = small({ content, nameStyle: 'west-germanic', featureNames: { 'island:3': { style: 'zh-default' }, 'island:4': { style: 'gone' } }, provinces: { 7: { name: '', locked: false, land: true, kind: 'land', style: 'zh-default' } } });
    const w = { small: s };
    expect(styleFor(w, { feature: { key: 'sea:1' } })).toMatchObject({ id: 'west-germanic', suffix: '' });
    expect(styleFor(w, { feature: { key: 'island:3' } })).toMatchObject({ id: 'zh-default', suffix: ':zh-default' });
    expect(styleFor(w, { feature: { key: 'island:4' } })).toMatchObject({ id: 'west-germanic', suffix: '' });
    // 落到地物上的改名优先于按键找的
    expect(styleFor(w, { feature: { key: 'island:3' }, override: {} })).toMatchObject({ id: 'west-germanic' });
    expect(styleFor(w, { province: 7 })).toMatchObject({ id: 'zh-default', suffix: ':zh-default' });
    expect(styleFor(w, { province: 8 })).toMatchObject({ id: 'west-germanic', suffix: '' });
    expect(missingStyles(s)).toEqual([{ where: 'island:4', id: 'gone' }]);
    // 世界默认的风格停用了：退回世界里第一种（中文·默认），并列出来
    const gone = small({ nameStyle: 'west-germanic' });
    expect(styleFor({ small: gone }).id).toBe(DEFAULT_STYLE);
    expect(missingStyles(gone)).toEqual([{ where: 'world', id: 'west-germanic' }]);
  });
});

describe('显示中文 / 原文 / 两者', () => {
  it('没有原文时三种都是中文；默认中文', () => {
    expect(DEFAULT_NAME_MODE).toBe('zh');
    expect(['zh', 'orig', 'both'].map((m) => nameText('卡尔维尔斯堡', 'Karvilsburg', m as never))).toEqual(['卡尔维尔斯堡', 'Karvilsburg', '卡尔维尔斯堡 Karvilsburg']);
    expect(['zh', 'orig', 'both'].map((m) => nameText('青云岛', undefined, m as never))).toEqual(['青云岛', '青云岛', '青云岛']);
    expect(nameText('卡尔', 'Karl')).toBe('卡尔');
    expect(nameLines('卡尔', 'Karl', 'both')).toEqual(['卡尔', 'Karl']);
    expect(nameLines('卡尔', undefined, 'both')).toEqual(['卡尔']);
  });
});
