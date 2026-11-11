import { describe, expect, it } from 'vitest';
import { digest } from '../../../core/digest';
import { CLIMATE_ZONES, TYPE_DEFAULTS, planetCells, planetSettings, settingsAt, PLANET_SIZES } from '../../../core/presets';
import { library } from '../../library';
import { DEFAULT_PLANET, formChoices, formGen, newWorldCommands, wizardWorldName } from './forms';
import { defaultChoice, generateCommand } from './human';
import { worldContentCommands } from './packChoice';
import { REGION_CELLS, chosenForm, defaultWizardChoice, wizardSummary, wizardWorld } from './wizardChoice';
import { terrainCommands, withTerrain } from './wizardTerrain';

// 第九十八轮：新建向导的第一屏只有缩略图，别的都收在“自定义…”里。默认值不变：
// 什么都不选、点第一张缩略图，发出去的设置和命令与第九十七轮逐字相同（世界是它们的确定的函数，金标准另钉着）

const lib = library.value;
// 第一张缩略图的种子：base + 0 × 7919
const seedOf = (base: number, k = 0) => (base + k * 7919) % 0xffffffff;

describe('默认的选择点第一张缩略图', () => {
  it('和第九十七轮（a08664b）的向导发出去的逐字相同：三个种子的摘要是在那个提交的代码上记下的', () => {
    // 出处：草稿目录的 wizard-base98.mts 对着 git archive a08664b 的拷贝跑出来的（照那时 Wizard.tsx 里的写法拼）
    const was: Record<number, string> = { 0: '308f3e23624fc863', 123456: '61707c8d23c77e4b', 999999: '99ad7faa0e0a2516' };
    for (const [base, d] of Object.entries(was)) {
      const w = wizardWorld(defaultWizardChoice(lib), seedOf(Number(base)), lib);
      expect(digest({ settings: w.settings, commands: w.commands }), `种子 ${base}`).toBe(d);
    }
  });

  it('就是原来那几行拼出来的：一块地区、群岛之海、4 万格、默认的库、带人文', () => {
    const seed = seedOf(424242);
    const human = defaultChoice(null, true, lib);
    const size = TYPE_DEFAULTS.archipelago.size;
    const center = CLIMATE_ZONES[TYPE_DEFAULTS.archipelago.zone].lat;
    const commands = newWorldCommands(withTerrain({ seed, type: 'archipelago' }, {}), wizardWorldName('region', DEFAULT_PLANET, formChoices(lib), 'archipelago'), seed, terrainCommands({}), generateCommand(human, null, lib), worldContentCommands(human, lib));
    const w = wizardWorld(defaultWizardChoice(lib), seed, lib);
    expect(w.settings).toEqual(settingsAt(size, center, 40000));
    expect(JSON.stringify(w.commands)).toBe(JSON.stringify(commands));
    expect(REGION_CELLS).toBe(40000);
    // 三条：新世界（加内容 + 造陆地）、生成人文、划分省份
    expect(w.commands.map((c) => (c.op === 'batch' ? c.label : c.op))).toEqual(['新世界“群岛之海”', expect.stringContaining('人文'), 'generate_provinces']);
  });

  it('只切到“整个星球”、别的不动：像地球、类地大小、同样的库和人文', () => {
    const seed = seedOf(7, 2);
    const c = { ...defaultWizardChoice(lib), kind: 'planet' as const };
    const choices = formChoices(lib);
    const form = chosenForm(c, choices)!;
    expect(form.key).toBe(DEFAULT_PLANET);
    const human = defaultChoice(null, true, lib);
    const commands = newWorldCommands(withTerrain(formGen(seed, form.form), {}), wizardWorldName('planet', DEFAULT_PLANET, choices, 'archipelago'), seed, terrainCommands({}), generateCommand(human, null, lib), worldContentCommands(human, lib));
    const w = wizardWorld(c, seed, lib, choices);
    expect(w.settings).toEqual(planetSettings('earth', planetCells(PLANET_SIZES.earth.radiusKm)));
    expect(JSON.stringify(w.commands)).toBe(JSON.stringify(commands));
  });
});

describe('“自定义…”收着时的一行', () => {
  it('写明现在用的是什么', () => {
    const c = defaultWizardChoice(lib);
    expect(wizardSummary(c, lib)).toBe('群岛之海 · 一片海域 · 中世纪与近世 · 带国家和城市');
    expect(wizardSummary({ ...c, kind: 'planet' }, lib)).toBe('像地球 · 大小：类地 · 中世纪与近世 · 带国家和城市');
    expect(wizardSummary({ ...c, terrain: { mountains: 1.4 }, human: { ...c.human, on: false } }, lib)).toBe('群岛之海 · 一片海域 · 地形调过 · 中世纪与近世 · 不生成人文');
    expect(wizardSummary({ ...c, human: { ...c.human, settlements: { on: false, landmarks: true } } }, lib)).toContain('带国家');
    expect(wizardSummary({ ...c, human: { ...c.human, countries: { on: false } } }, lib)).toContain('只有人口和文化');
  });
});
