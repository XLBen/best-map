import { describe, expect, it } from 'vitest';
import { ERA_PACKS } from '../../core/packs/eras';
import { continents, humanExec, snapshot } from '../../core/testing/fixtures';
import type { Bloc, CountryMeta, World } from '../../core/world';
import { countryViewHint, humanViews } from './defs/layers';
import { patternLine } from './domain/countries';

// 第七十五轮：国家档案“概览”里的格局一行、“国家”一层的说明（附庸、殖民地、公司领地用宗主的浅色）

const meta = (id: number, more: Partial<CountryMeta> = {}): CountryMeta =>
  ({ id, name: `国${id}`, base: { zh: `国${id}` }, color: '#336699', flag: {} as CountryMeta['flag'], government: 'g', primaryCulture: 'c', acceptedGroups: [], allies: [], rivals: [], ruler: { name: '' }, founded: 1, history: '', ...more }) as CountryMeta;
const worldOf = (list: CountryMeta[], blocs?: Bloc[]): Pick<World, 'small'> => ({ small: { countries: Object.fromEntries(list.map((m) => [m.id, m])), ...(blocs ? { blocs } : {}) } as World['small'] });

describe('档案的格局一行', () => {
  const lord = meta(1, { name: '泰伦' });
  it('格局里的角色、联邦的成员邦、从属', () => {
    const w = worldOf(
      [
        lord,
        meta(2, { role: 'holy-empire' }),
        meta(3, { role: 'city-league' }),
        meta(4, { overlord: 1, subject: 'colony' }),
        meta(5, { role: 'nation-state' }),
        meta(6, { role: 'outposts', overlord: 1, subject: 'company' }),
        meta(7, { role: 'race-realms:hold', overlord: 1 }),
        meta(8),
        meta(9),
        meta(10, { role: 'race-realms:forest' }),
      ],
      [{ id: 1, kind: 'federation', name: '东方联邦', leader: 9, members: [9], color: '#000000' }],
    );
    const line = (id: number) => patternLine(w, w.small.countries![id]);
    expect(line(2)).toBe('神圣帝国的成员');
    expect(line(3)).toBe('城邦同盟的成员');
    expect(line(4)).toBe('殖民地 · 宗主国 泰伦');
    expect(line(5)).toBe('民族国家');
    // 殖民地、公司领地只写从属那一句
    expect(line(6)).toBe('公司领地 · 宗主 泰伦');
    expect(line(7)).toBe('山中要塞同盟的成员；附庸 · 宗主 泰伦');
    expect(line(8)).toBeNull();
    expect(line(9)).toBe('东方联邦的成员邦');
    expect(line(10)).toBe('古林王国');
  });

  it('生成的奇幻世界：精灵、矮人、兽人的国家都有一行', () => {
    const eng = snapshot('patterns-ui:fantasy', () => {
      const e = continents();
      humanExec(e, { op: 'generate_human', packs: [['fantasy']], groups: ERA_PACKS.get('fantasy')!.cultures.map(([id, weight]) => ({ id, weight })), countries: {} });
      return e;
    });
    const lines = Object.values(eng.world.small.countries!).map((m) => patternLine(eng.world, m));
    for (const t of ['古林王国', '山中要塞同盟的成员', '荒原部落联盟的成员']) expect(lines).toContain(t);
  });
});

describe('“国家”一层的说明', () => {
  it('附庸用宗主的浅色；有殖民地、公司领地时也写上', () => {
    expect(countryViewHint(worldOf([meta(1)]).small)).toBe('附庸用宗主的浅色');
    expect(countryViewHint(worldOf([meta(1), meta(2, { overlord: 1, subject: 'colony' })]).small)).toBe('附庸、殖民地用宗主的浅色');
    expect(countryViewHint(worldOf([meta(1), meta(2, { overlord: 1, subject: 'company' }), meta(3, { overlord: 1, subject: 'colony' })]).small)).toBe('附庸、殖民地、公司领地用宗主的浅色');
    // 图层面板里的“国家”带着这一句
    const w = { small: { ...worldOf([meta(1), meta(2, { overlord: 1, subject: 'company' })]).small, human: { countryRules: { fragmentation: 0.5, seed: 1 } } } } as unknown as Pick<World, 'small'>;
    expect(humanViews(w).find((v) => v.id === 'country')!.hint).toBe('附庸、公司领地用宗主的浅色');
  });
});
