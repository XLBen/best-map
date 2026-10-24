import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_STYLES } from '../../core/packs/names';
import { continents } from '../../core/testing/fixtures';
import { featureStyleCommand, missingCount, restyleOffer, restyleProvincesCommand, styleChoices } from './packs/styles';
import { stemNaming } from './river/query';

// 第二十轮的界面：地名显示中文 / 原文 / 两者存在偏好里；“地名”“省份”里的风格；锁定一条自然的河时原文一起记下

vi.stubGlobal('Worker', class {});
const { parsePrefs } = await import('../state');

const germanic = BUILTIN_STYLES.find((s) => s.id === 'west-germanic')!;
const enable = { op: 'set_content' as const, kind: 'nameStyle', id: germanic.id, item: germanic as unknown as Record<string, unknown> };

describe('第二十轮的界面', () => {
  it('偏好：地名显示默认中文；存过的读回来；不认识的值、坏的 JSON 用默认的', () => {
    expect(parsePrefs(null)).toEqual({ wheel: 'auto', projection: 'equirect', names: 'zh' });
    expect(parsePrefs(JSON.stringify({ wheel: 'pan', names: 'both' }))).toEqual({ wheel: 'pan', projection: 'equirect', names: 'both' });
    expect(parsePrefs(JSON.stringify({ names: 'latin' })).names).toBe('zh');
    expect(parsePrefs('{坏').names).toBe('zh');
  });

  it('风格的选法：世界里启用的几种；地物换风格写在落到它上面的改名上；停用后提示有几处', () => {
    const eng = continents();
    expect(styleChoices(eng.world.small).map((c) => c.id)).toEqual(['zh-default']);
    eng.exec(enable);
    expect(styleChoices(eng.world.small).map((c) => c.name)).toEqual(['中文·默认', '西欧·日耳曼']);
    const isle = eng.world.derived.features.find((f) => f.type === 'island' && !f.custom)!;
    eng.exec(featureStyleCommand(eng.world, isle, 'west-germanic'));
    const after = eng.world.derived.features.find((f) => f.key === isle.key)!;
    expect([after.style, !!after.orig]).toEqual(['west-germanic', true]);
    expect(missingCount(eng.world.small)).toBe(0);
    eng.exec({ op: 'set_content', kind: 'nameStyle', id: germanic.id, item: null });
    expect(missingCount(eng.world.small)).toBe(1);
  });

  it('按世界默认重起省名：锁定的、自己选了风格的不动；一步，可以撤销', () => {
    const eng = continents({ provinces: true });
    eng.exec(enable);
    // 只用内置中文、省名也是中文时不提
    expect(restyleOffer(eng.world)).toBeNull();
    eng.exec({ op: 'set_name_style', id: 'west-germanic' });
    expect(restyleOffer(eng.world)).toEqual(restyleProvincesCommand(eng.world));
    const ps = () => eng.world.small.provinces;
    const ids = Object.keys(ps()).map(Number);
    expect(ids.every((id) => !ps()[id].orig)).toBe(true);
    eng.exec({ op: 'set_province', id: ids[0], locked: true });
    const before = { ...ps()[ids[0]] };
    const cmd = restyleProvincesCommand(eng.world)!;
    expect(cmd).toMatchObject({ op: 'batch', label: `按“西欧·日耳曼”重起省名 · ${ids.length - 1} 个` });
    eng.exec(cmd);
    expect(ps()[ids[0]]).toEqual(before);
    expect(ids.slice(1).filter((id) => ps()[id].orig).length).toBeGreaterThan((ids.length - 1) * 0.8);
    eng.undo();
    expect(ids.every((id) => !ps()[id].orig)).toBe(true);
  });

  it('锁定一条自然的河：自动起的名字连同原文记下', () => {
    const eng = continents();
    eng.exec(enable);
    eng.exec({ op: 'set_name_style', id: 'west-germanic' });
    const river = eng.world.derived.features.find((f) => f.type === 'river' && f.guide === undefined && f.orig)!;
    expect(stemNaming(eng.world, river)).toEqual({ nameKey: river.key, autoName: river.name, autoOrig: river.orig });
    expect(stemNaming(eng.world, { ...river, orig: undefined })).toEqual({ nameKey: river.key, autoName: river.name });
    expect(stemNaming(eng.world, null)).toEqual({ name: '' });
  });
});
