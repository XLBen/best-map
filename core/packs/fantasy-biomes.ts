import type { Command } from '../commands';
import { type Rect, type Species, withRect } from '../species';

// 内置示例包“奇幻生态”的五种生态（第三批）：直接是数据，资源包、测试、“添加示例生态…”都用它。
// 每种都用到了第三批的一样新东西：花纹与发光（visual）、对周围的影响与侵占（effects）、
// 自带的地名（feature）、长在哪里与颜色的脚本（scripts）。种子用固定的 seedKey：改了 id 花纹也不变。
//
// 竞争力与脚本的阈值调过：五种一起加上时，每种占陆地都不超过 8%，也都至少有一格（见 core/fantasy-biomes.test.ts）。
// fbmAt 在陆地上大致是：中位数 0，80% 分位 0.18，90% 0.26，95% 0.32（计划里 0.3–0.75 的阈值几乎碰不到）。
// 调好后五种一起加上，占陆地的比例（水晶 / 死亡 / 虫群 / 神圣 / 血腥）：
//   1.2 万格大陆（北纬 20°–72°，测试用）     0.3% / 1.7% / 1.2% / 2.3% / 0.4%（19 / 92 / 67 / 124 / 20 格）
//   同一块大陆放到南北纬 25° 之间            0.9% / 1.1% / 0.9% / 2.2% / 只有 2 格
//   4 万格地区（默认大小，两个种子）          0.2–0.4% / 0.5–0.7% / 1.7–2.5% / 0.5–1.3% / 0.2–0.8%
//   8000 格星球                              0.1% / 0%   / 0.1% / 2.9% / 3.1%
//   10 万格星球                              0.1% / 1.5% / 0.1% / 2.5% / 0.7%
// 死亡森林读的地形湿度指数随格子多少变（格子少的星球上普遍偏湿），所以 8000 格的星球上没有
// 计划里的原始值：竞争力 5 / 3.5 / 2.5 / 6 / 4，阈值见各脚本旁

const script = (src: string) => ({ api: 1 as const, src });

const make = (base: Omit<Species, 'tolerances'>, rect: Rect): Species => withRect({ ...base, tolerances: [] }, rect);

// 森林类的内置生态：虫群侵占它们（和水晶丛林）
const FORESTS = ['taiga', 'temperate_forest', 'subtropical_forest', 'dry_forest', 'monsoon_forest', 'rainforest'];

// 神圣之地用的自定义场：用户在“圣地”场上涂了的地方一定长（0–1）
export const FANTASY_FIELDS = ['holy'] as const;

export const FANTASY_BIOMES: Species[] = [
  make(
    {
      id: 'crystal_jungle',
      name: '水晶丛林',
      color: '#4fc9c0',
      terrain: 'jungle',
      // 计划 5
      competition: 4.5,
      visual: { pattern: 'sparkle', color2: '#eafcff', amount: 0.9, size: 0.35, glow: 0.35, glowColor: '#8ff6ff' },
      feature: { label: '晶林', names: [{ p: '{color}晶林' }, { p: '{myth}晶丛' }, { p: '{nature}水晶林' }] },
      scripts: {
        placement: script(
          [
            '// 晶簇一片一片地长；晶川两岸最多（还没有晶川时只看斑块）',
            // 计划 smoothstep(0.0, 0.35, …)：一半的地方都有
            'const patch = smoothstep(0.15, 0.35, fbmAt(5, 3));',
            "return clamp(patch + 0.7 * river('crystal_river'), 0, 1);",
          ].join('\n'),
        ),
      },
      seedKey: 'fantasy/crystal_jungle',
    },
    { t0: 16, t1: 40, m0: 1.0, m1: 50 },
  ),
  make(
    {
      id: 'dead_forest',
      name: '死亡森林',
      color: '#5d534b',
      terrain: 'forest',
      // 计划 3.5
      competition: 4,
      visual: { pattern: 'cracks', color2: '#2b2420', amount: 0.7, size: 0.6 },
      effects: { climate: { dP: -0.22, radiusKm: 300 } },
      feature: { label: '枯林', names: [{ p: '枯{plant}林' }, { p: '{color}骨林' }, { p: '死{forest}林' }] },
      scripts: {
        placement: script(
          [
            '// 离水越远越容易枯死，成片出现',
            // 计划 (1 − smoothstep(14, 20, wetness)) × smoothstep(−0.1, 0.25, …)
            'return (1 - smoothstep(16, 19, wetness)) * smoothstep(0.1, 0.25, fbmAt(3, 3, 2));',
          ].join('\n'),
        ),
        color: script(['// 越高越灰白', 'return mixColor(color, [150, 142, 134], smoothstep(600, 2400, elevation));'].join('\n')),
      },
      seedKey: 'fantasy/dead_forest',
    },
    { t0: -6, t1: 18, m0: 0.35, m1: 1.6 },
  ),
  make(
    {
      id: 'swarm_zone',
      name: '虫群占领区',
      color: '#7d8a2c',
      terrain: 'jungle',
      // 计划 2.5：再乘上侵占的 ×(1 + 2.5 × 森林的适宜度)，在森林里会到 8.75，整片吞掉
      competition: 1.5,
      visual: { pattern: 'mottle', color2: '#3b4411', amount: 0.8, size: 0.8 },
      effects: { invade: { targets: [...FORESTS, 'crystal_jungle'], strength: 2.5 } },
      feature: { label: '虫巢', names: [{ p: '{animal}巢' }, { p: '{color}虫原' }, { p: '{number}虫之地' }] },
      scripts: {
        // 计划 smoothstep(0.25, 0.55, …)
        placement: script(['// 一大块一大块地占', 'return smoothstep(0.2, 0.45, fbmAt(2.5, 2, 7));'].join('\n')),
      },
      seedKey: 'fantasy/swarm_zone',
    },
    { t0: 8, t1: 40, m0: 0.5, m1: 50 },
  ),
  make(
    {
      id: 'holy_land',
      name: '神圣之地',
      color: '#efe0a6',
      terrain: 'plains',
      // 计划 6：会占掉大半高地
      competition: 2.5,
      visual: { pattern: 'none', glow: 0.3, glowColor: '#fff1b0' },
      effects: { climate: { dT: 2, dP: 0.1, radiusKm: 250 } },
      feature: { label: '圣地', names: [{ p: '圣{nature}原' }, { p: '{myth}圣地' }, { p: '{quality}光之地' }] },
      scripts: {
        placement: script(
          [
            '// 在“圣地”场上涂过的地方一定长；别处只在高地上零星几片',
            // 计划 smoothstep(0.45, 0.7, …)
            "return clamp(field('holy') + smoothstep(0.12, 0.3, fbmAt(1.5, 4, 11)) * smoothstep(300, 1200, elevation), 0, 1);",
          ].join('\n'),
        ),
      },
      seedKey: 'fantasy/holy_land',
    },
    { t0: -10, t1: 32, m0: 0.2, m1: 50 },
  ),
  make(
    {
      id: 'bloody_land',
      name: '血腥之地',
      color: '#7b1f1f',
      terrain: 'steppe',
      // 计划 4
      competition: 3,
      visual: { pattern: 'veins', color2: '#3a0606', amount: 0.8, size: 0.7 },
      feature: { label: '血原', names: [{ p: '血{place}' }, { p: '赤{nature}原' }, { p: '{color}血野' }] },
      scripts: {
        placement: script(
          [
            '// 长在血河两岸。地图上还没有血河时，长在离河近、又碰上斑块的地方',
            "if (hasRiver('blood_river')) return smoothstep(0.2, 0.6, river('blood_river'));",
            'const cellKm = Math.sqrt(areaKm2);',
            'return (1 - smoothstep(0.5 * cellKm, 2.5 * cellKm, riverDist)) * smoothstep(0.15, 0.35, fbmAt(2, 2, 13));',
          ].join('\n'),
        ),
      },
      seedKey: 'fantasy/bloody_land',
    },
    { t0: 4, t1: 40, m0: 0.15, m1: 1.4 },
  ),
];

// 把示例生态加进一个世界的命令（一整步）：先加它们用到的自定义场，再加生态。已有的场、同 id 的生态跳过
export function fantasyBiomeCommands(existing: { fields: readonly string[]; species: readonly string[] }, picks: readonly string[] = FANTASY_BIOMES.map((sp) => sp.id)): Command {
  const chosen = FANTASY_BIOMES.filter((sp) => picks.includes(sp.id) && !existing.species.includes(sp.id));
  const fields = chosen.some((sp) => sp.id === 'holy_land') ? FANTASY_FIELDS.filter((f) => !existing.fields.includes(f)) : [];
  return {
    op: 'batch',
    label: `添加了示例生态：${chosen.map((sp) => sp.name).join('、')}`,
    commands: [...fields.map((name): Command => ({ op: 'add_field', name })), ...chosen.map((species): Command => ({ op: 'add_species', species }))],
  };
}
