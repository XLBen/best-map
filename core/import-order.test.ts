import { describe, expect, it, vi } from 'vitest';

// 循环引用：species.ts 引用 script.ts 的 scriptsSchema，script.ts 经 world.ts 又引用 species.ts，
// commands.ts 在模块顶层读 speciesSchema、script.ts 在模块顶层继承 CommandError（在 errors.ts 里）。
// 星球形态又多了 commands.ts → generate.ts → planet-form.ts → script.ts、terrain.ts → planet-gen.ts → script.ts，
// generate.ts 在模块顶层就要用 planetFormSchema（世界类型在不引用别的模块的 world-types.ts 里）。
// 画的河的类型 id 与生态 id 同一条规则，world.ts 在模块顶层就要用（在只引用 zod 的 type-id.ts 里）。
// 不管先引用哪一个模块都不能碰上“初始化之前不能访问”：每个模块都在清空的模块表里先引用一次

const MODULES = ['species', 'script', 'commands', 'errors', 'world', 'engine', 'vegetation', 'constraints', 'features', 'biome-look', 'biome-scripts', 'packs/fantasy-biomes', 'names', 'provinces', 'select', 'seams', 'planet-form', 'generate', 'planet-gen', 'terrain', 'world-types', 'packs/fantasy-forms', 'packs/fantasy', 'packs', 'type-id', 'river-types', 'effects', 'packs/fantasy-rivers', 'name-styles', 'content/registry', 'content/kinds', 'packs/names/index', 'human/index', 'human/kinds', 'human/rules', 'human/terrain-class', 'human/resources', 'human/cells', 'human/peaks', 'human/era', 'human/habitability', 'human/cultures', 'human/population', 'human/generate', 'human/layers', 'human/culture-style', 'human/pop-kinds', 'human/groups', 'human/space', 'packs/eras/index', 'human/government', 'human/gov-kinds', 'human/countries', 'human/country-names', 'human/country-edit', 'human/country-layers', 'human/flags', 'packs/governments/index', 'human/settlements', 'human/roads', 'human/landmarks', 'human/points', 'human/settle-gen', 'human/settle-types', 'human/settle-content', 'human/settle-kinds', 'human/archive', 'packs/settlements/index'];

describe('引用的先后', () => {
  for (const m of MODULES) {
    it(`先引用 ${m}`, async () => {
      vi.resetModules();
      await import(`./${m}.ts`);
      const species = await import('./species');
      const commands = await import('./commands');
      const script = await import('./script');
      const parsed = species.speciesSchema.parse({ id: 'a', scripts: { placement: { api: 1, src: 'return 1;' } } });
      expect(parsed.scripts?.placement?.src).toBe('return 1;');
      // 没写的新项解析后没有这个键
      expect(Object.keys(species.speciesSchema.parse({ id: 'b' }))).toEqual(['id', 'name', 'color', 'terrain', 'competition', 'tolerances']);
      const err = new script.ScriptError({ owner: 'x', kind: 'placement', reason: 'syntax', text: 't', raw: 'r', message: 'm' });
      expect(err).toBeInstanceOf(commands.CommandError);
      // 星球形态：worldgenSchema 顶层用到的 planetFormSchema、世界类型都已经初始化
      const generate = await import('./generate');
      const forms = await import('./packs/fantasy-forms');
      expect(generate.WORLD_TYPES).toContain('inland_sea');
      expect(generate.worldgenSchema.parse({ seed: 1, type: 'continents', form: forms.TWIN_CONTINENTS }).form?.name).toBe('双子大陆');
    });
  }
});
