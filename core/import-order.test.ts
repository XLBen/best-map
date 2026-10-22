import { describe, expect, it, vi } from 'vitest';

// 循环引用：species.ts 引用 script.ts 的 scriptsSchema，script.ts 经 world.ts 又引用 species.ts，
// commands.ts 在模块顶层读 speciesSchema、script.ts 在模块顶层继承 CommandError（在 errors.ts 里）。
// 不管先引用哪一个模块都不能碰上“初始化之前不能访问”：每个模块都在清空的模块表里先引用一次

const MODULES = ['species', 'script', 'commands', 'errors', 'world', 'engine', 'vegetation', 'constraints', 'features', 'biome-look', 'biome-scripts', 'packs/fantasy-biomes', 'packs/fantasy', 'packs', 'names', 'provinces', 'select', 'seams'];

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
    });
  }
});
