import { describe, expect, it } from 'vitest';
import type { Species } from '../../core/species';
import { DEFAULT_RADIUS_KM, cleanVisual, dpOfPercent, featureOf, namesProblem, percentOfDp, toggleTarget, visualPatch, withClimate, withInvade } from './SpeciesAdvanced';

// 生态的“高级：图案、效果与脚本”：每次只改动这次动了的那一项，按世界上最新的这种生态做补丁

const sp = (extra: Partial<Species> = {}) => ({ id: 'dead', name: '死亡森林', color: '#556644', terrain: 'forest', competition: 1, tolerances: [], ...extra }) as Species;

describe('对周围的影响：只改动了的那一项', () => {
  it('资源包里超出滑块范围的降水（−78%）不会因为改了冷暖而被改掉', () => {
    const effects = { climate: { dP: -1.5, radiusKm: 250 } };
    expect(withClimate(effects, { dT: 2 })).toEqual({ climate: { dT: 2, dP: -1.5, radiusKm: 250 } });
    expect(withClimate({ climate: { dT: 8, radiusKm: 100 } }, { radiusKm: 400 })).toEqual({ climate: { dT: 8, radiusKm: 400 } });
  });

  it('冷暖、干湿都回到 0：去掉；侵占照样留着；什么都没有了是 null', () => {
    const invade = { targets: ['forest'], strength: 2 };
    expect(withClimate({ climate: { dT: 2, radiusKm: 300 }, invade }, { dT: 0 })).toEqual({ invade });
    expect(withClimate({ climate: { dT: 2, radiusKm: 300 } }, { dT: 0 })).toBeNull();
    expect(withClimate(undefined, { dP: dpOfPercent(20) })).toEqual({ climate: { dP: 0.1823, radiusKm: DEFAULT_RADIUS_KM } });
  });

  it('降水的百分比与 dP 互换，滑块两端都在范围里', () => {
    expect(dpOfPercent(-50)).toBeCloseTo(Math.log(0.5), 4);
    expect(dpOfPercent(100)).toBeCloseTo(Math.log(2), 4);
    expect(percentOfDp(dpOfPercent(35))).toBe(35);
    expect(percentOfDp(-0.22)).toBe(-20);
  });
});

describe('侵占', () => {
  const order = ['a', 'b', 'c', 'dead'];
  it('点一下加上、再点去掉；按生态列表排，已经不在了的目标留在后面', () => {
    expect(toggleTarget([], 'b', order)).toEqual(['b']);
    expect(toggleTarget(['c', 'gone'], 'a', order)).toEqual(['a', 'c', 'gone']);
    expect(toggleTarget(['a', 'c'], 'a', order)).toEqual(['c']);
  });

  it('在最新的样子上改：前一下点的、对周围的影响都留着；最后一个去掉就没有侵占', () => {
    const climate = { dT: 1, radiusKm: 300 };
    const once = withInvade({ climate }, { toggle: 'a' }, order);
    expect(once).toEqual({ climate, invade: { targets: ['a'], strength: 1.5 } });
    const twice = withInvade(once!, { toggle: 'c' }, order);
    expect(twice).toEqual({ climate, invade: { targets: ['a', 'c'], strength: 1.5 } });
    expect(withInvade(twice!, { strength: 3 }, order)).toEqual({ climate, invade: { targets: ['a', 'c'], strength: 3 } });
    // 资源包里的强度 6（滑块只到 5）：点目标时不变
    expect(withInvade({ invade: { targets: ['a'], strength: 6 } }, { toggle: 'b' }, order)?.invade?.strength).toBe(6);
    expect(withInvade({ invade: { targets: ['a'], strength: 2 } }, { toggle: 'a' }, order)).toBeNull();
  });
});

describe('外观', () => {
  it('只改一项；没有花纹也不发光时去掉', () => {
    const cur = sp({ visual: { pattern: 'cracks', amount: 0.4 } });
    expect(visualPatch(cur, { glow: 0.5 })).toEqual({ visual: { pattern: 'cracks', amount: 0.4, glow: 0.5 } });
    expect(visualPatch(cur, { amount: 0.4 })).toBeNull();
    expect(visualPatch(sp({ visual: { pattern: 'none', glow: 0.3 } }), { glow: 0 })).toEqual({ visual: null });
    expect(cleanVisual({ pattern: 'none' })).toBeNull();
  });
});

describe('地名', () => {
  it('长度按 schema 的算法（UTF-16）', () => {
    expect(namesProblem('晶林', ['{color}晶林'])).toBeNull();
    expect(namesProblem('一二三四五六七八九', [])).toBe('类型名最多 8 个字');
    // 一个生僻字（两个 UTF-16 单位）× 21 = 42 > 40
    expect(namesProblem('晶林', ['𠀀'.repeat(21)])).toBe('第 1 个模板太长了（最多 40 个字）');
    expect(namesProblem('晶林', Array.from({ length: 21 }, (_, k) => `名${k}`))).toBe('模板最多 20 个');
  });

  it('只写了模板时类型名用生态的名字（截到 8 个以内，不截断一个字）；没改的模板留着权重', () => {
    const cur = sp({ name: '𠀀𠀀𠀀𠀀𠀀', feature: { label: '枯林', names: [{ p: '{color}枯林', w: 3 }] } });
    expect(featureOf(cur, '', ['{color}枯林', '{myth}死林'])).toEqual({ label: '𠀀𠀀𠀀𠀀', names: [{ p: '{color}枯林', w: 3 }, { p: '{myth}死林' }] });
    expect(featureOf(cur, '  ', [])).toBeNull();
    expect(featureOf(cur, '枯木林', [])).toEqual({ label: '枯木林' });
  });
});
