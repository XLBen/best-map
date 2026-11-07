import { beforeAll, describe, expect, it } from 'vitest';
import { kindOf } from '../../../core/content/registry';
import type { Engine } from '../../../core/engine';
import type { Era } from '../../../core/human';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { engineFor, humanExec } from '../../../core/testing/fixtures';
import { BUILTIN_COUNTRY_PATTERNS } from '../../../core/packs/countries';
import { type LibraryEntry, library } from '../../library';
import { addablePatterns, eraPatternRows, MAX_ERA_PATTERNS, type PatternChoice, withNationalism, withPattern, withPatternAmount, withoutPattern } from './era-patterns';
import type { Obj } from './fields';
import { commitItem, worldItemCommand } from './page-actions';
import { segmentsOf } from './page-segments';
import type { PageCtx } from './pages';

// 第七十五轮：资源库里时代页面的“国家”一段——国家格局一种一个“多少”的滑块、加、删、文化的倒向

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const CHOICES: PatternChoice[] = BUILTIN_COUNTRY_PATTERNS.map((p) => p);
const fantasy = (): Obj => ({ id: 'fantasy', name: '奇幻', patterns: [{ pattern: 'race-realms', amount: 1 }, { pattern: 'alliances', amount: 1 }, { pattern: 'realm-vassals' }], nationalism: 0.2 });

describe('一段里有什么', () => {
  it('时代的“国家”一段：海、国家大小、等级，加上国家格局、文化的倒向；集团的称号另一段', () => {
    const segs = segmentsOf(kindOf('era')!);
    const state = segs.find((s) => s.id === 'state')!;
    expect(state.title).toBe('国家');
    expect(state.custom).toBe('eraPatterns');
    expect(state.fields.map((f) => f.key)).toEqual(['seaClaimKm', 'countryKm2', 'tiers', 'patterns', 'nationalism']);
    expect(segs.find((s) => s.id === 'relations')!.fields.map((f) => f.key)).toEqual(['relations']);
    expect(kindOf('era')!.fields.find((f) => f.key === 'nationalism')!.label).toBe('文化的倒向');
  });

  it('一种格局一行：名字、现在的多少（时代没写时用格局自己的）、多少是什么意思；这里没有的标出来', () => {
    const era = { ...fantasy(), patterns: [...(fantasy().patterns as object[]), { pattern: 'gone', amount: 2 }] };
    const rows = eraPatternRows(era, CHOICES);
    expect(rows.map((r) => [r.id, r.name, r.amount, r.own, r.missing])).toEqual([
      ['race-realms', '种族王国', 1, true, false],
      ['alliances', '军事同盟', 1, true, false],
      ['realm-vassals', '封臣与朝贡', 1, false, false],
      ['gone', 'gone', 2, true, true],
    ]);
    expect(rows[0].hint).toContain('种族王国：');
  });
});

describe('改了是整个时代换掉', () => {
  it('拖一种的多少：只写那一条，别的、别的键不动', () => {
    const before = fantasy();
    const next = withPatternAmount(before, 2, 0.5);
    expect(next.patterns).toEqual([{ pattern: 'race-realms', amount: 1 }, { pattern: 'alliances', amount: 1 }, { pattern: 'realm-vassals', amount: 0.5 }]);
    expect({ ...next, patterns: undefined }).toEqual({ ...before, patterns: undefined });
    expect(before.patterns).toEqual(fantasy().patterns);
  });

  it('删除一种；都删了不写 patterns', () => {
    let era = withoutPattern(fantasy(), 1);
    expect((era.patterns as { pattern: string }[]).map((p) => p.pattern)).toEqual(['race-realms', 'realm-vassals']);
    era = withoutPattern(withoutPattern(era, 0), 0);
    expect('patterns' in era).toBe(false);
  });

  it('加一种：多少用格局自己的；列过的、满了的不能加，下拉里也没有', () => {
    const era = withPattern(fantasy(), 'outposts')!;
    expect((era.patterns as unknown[]).at(-1)).toEqual({ pattern: 'outposts' });
    expect(withPattern(era, 'outposts')).toBeNull();
    expect(addablePatterns(era, CHOICES).map((c) => c.id)).not.toContain('outposts');
    expect(addablePatterns(fantasy(), CHOICES).length).toBe(CHOICES.length - 3);
    const full = { patterns: CHOICES.slice(0, MAX_ERA_PATTERNS).map((c) => ({ pattern: c.id })) };
    expect(withPattern(full, CHOICES[MAX_ERA_PATTERNS].id)).toBeNull();
    expect(addablePatterns(full, CHOICES)).toEqual([]);
  });

  it('文化的倒向：写上、去掉', () => {
    expect(withNationalism(fantasy(), 0.65).nationalism).toBe(0.65);
    expect('nationalism' in withNationalism(fantasy(), undefined)).toBe(false);
  });
});

describe('走资源库的改法', () => {
  let eng: Engine;
  beforeAll(() => {
    library.value = BUILTIN;
    eng = engineFor({ cells: 2000, seed: 2 });
    humanExec(eng, { op: 'generate_human', packs: [['fantasy']], groups: [{ id: 'elven', weight: 1 }, { id: 'westmark', weight: 1 }], countries: {} });
  });
  const ctxOf = (): PageCtx => ({ world: { ...eng.world }, lib: BUILTIN });
  const eraOf = () => eng.world.small.content!.era!.fantasy as unknown as Obj;

  it('本世界：一条命令（可以撤销），时代换成新的样子；只改了格局与文化的倒向', () => {
    const kind = kindOf('era')!;
    const before = eraOf();
    const next = withNationalism(withPatternAmount(withoutPattern(before, 1), 0, 2), 0.7);
    const cmd = worldItemCommand(kind, 'fantasy', next, ctxOf().world!)!;
    expect(cmd.op).toBe('batch');
    const e = eng.clone();
    e.exec(cmd);
    const now = e.world.small.content!.era!.fantasy as Era;
    expect(now.patterns).toEqual([{ pattern: 'race-realms', amount: 2 }, { pattern: 'realm-vassals' }]);
    expect(now.nationalism).toBe(0.7);
    expect({ ...now, patterns: undefined, nationalism: undefined }).toEqual({ ...(before as unknown as Era), patterns: undefined, nationalism: undefined });
    e.undo();
    expect(e.world.small.content!.era!.fantasy).toEqual(before);
  });

  it('内置的库只读：不改', () => {
    const kind = kindOf('era')!;
    const era = BUILTIN.find((e) => e.key === 'fantasy')!;
    expect(commitItem({ t: 'lib', key: era.key }, kind, 'fantasy', withPatternAmount(fantasy(), 0, 3), ctxOf())).toBe('readonly');
  });
});
