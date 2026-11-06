import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveImport, runtimeImports } from '../testing/imports';

// 第六十九轮：界面的分层（规则写在 docs/dev/ui.md 的“分层”）。只看运行时还在的引用（import type 不算），测试文件不算。
//   1. components/ 下只引用 core/、库和 components/ 自己（不认识世界、状态、资源库）
//   2. defs/ 下不引用 panels/、tools/（含把它们一起导出的 tools.ts）和任何 .tsx：工具表只声明，部件、工具做什么各自登记进来
//   3. src/ 下的 .ts 不引用 .tsx（逻辑不放在组件文件里）
//   4. src/state.ts 与 src/state/ 下不引用 src/ui/
//   5. src/ui/、src/state.ts、src/state/ 之间没有绕成圈的引用（第七十轮起 state/ 下的也算）
// 第七十轮加的：
//   6. panels/ 只经 tools/api.ts、tools/public.ts 用工具（不引用 tools.ts 和各类工具的文件）
//   7. shell/ 不引用具体的档案（抽屉按 defs/archive-registry.ts 登记的画）
//   8. 界面只经 state.ts 引用状态，不直接引用 state/ 下的文件（测试里 vi.mock('../state') 换掉 exec 等，绕过去就换不掉）
//   9. domain/ 不引用 panels/、shell/、tools/、river/ 和 .tsx（领域逻辑不碰界面的部件和工具）

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'testing' && f !== '__snapshots__') sources(p, out);
    } else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

// 文件 → 它运行时引用的文件（都相对仓库根）
const graph = new Map<string, string[]>();
for (const f of sources(join(root, 'src'))) {
  const deps = runtimeImports(f)
    .map((s) => resolveImport(f, s))
    .filter((p): p is string => !!p)
    .map((p) => relative(root, p));
  graph.set(relative(root, f), deps);
}

const edges = (pred: (from: string, to: string) => boolean) => [...graph].flatMap(([f, deps]) => deps.filter((d) => pred(f, d)).map((d) => `${f} → ${d}`));

const isTools = (f: string) => f.startsWith('src/ui/tools/') || f === 'src/ui/tools.ts';
const isState = (f: string) => f === 'src/state.ts' || f.startsWith('src/state/');
// 具体的档案：抽屉里的四种（连同国家档案的几页、派系）
const isArchive = (f: string) => /^src\/ui\/(CountryArchive|BlocArchive|SettleArchive|ClimateChart|CountryFactions)\.tsx$/.test(f) || f.startsWith('src/ui/archives/');

describe('界面的分层（第六十九轮）', () => {
  it('读得到引用（对照：App 引用面板，面板引用状态）', () => {
    expect(graph.size).toBeGreaterThan(200);
    expect(graph.get('src/ui/App.tsx')).toContain('src/ui/panels/AdjustPanel.tsx');
    expect(graph.get('src/ui/panels/lakes.tsx')).toContain('src/state.ts');
  });

  it('components/ 只引用 core/ 和 components/', () => {
    expect(edges((f, d) => f.startsWith('src/ui/components/') && !d.startsWith('core/') && !d.startsWith('src/ui/components/'))).toEqual([]);
  });

  it('defs/ 不引用 panels/、tools/ 和 .tsx', () => {
    expect(edges((f, d) => f.startsWith('src/ui/defs/') && (d.startsWith('src/ui/panels/') || isTools(d) || d.endsWith('.tsx')))).toEqual([]);
    expect([...graph.keys()].filter((f) => f.startsWith('src/ui/defs/') && f.endsWith('.tsx'))).toEqual([]);
  });

  it('.ts 不引用 .tsx', () => {
    expect(edges((f, d) => f.endsWith('.ts') && d.endsWith('.tsx'))).toEqual([]);
  });

  it('state.ts、state/ 不引用界面', () => {
    expect(edges((f, d) => isState(f) && d.startsWith('src/ui/'))).toEqual([]);
    // 对照：state.ts 确实引用 state/ 下的文件
    expect(graph.get('src/state.ts')).toContain('src/state/worker-host.ts');
  });

  it('src/ui/、state.ts、state/ 之间不绕成圈', () => {
    const inside = (f: string) => f.startsWith('src/ui/') || isState(f);
    // 强连通分量（Tarjan）：大于一个文件的就是圈
    let n = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const on = new Set<string>();
    const cycles: string[][] = [];
    const visit = (v: string) => {
      index.set(v, n);
      low.set(v, n);
      n++;
      stack.push(v);
      on.add(v);
      for (const w of graph.get(v)!.filter(inside)) {
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (low.get(v) === index.get(v)) {
        const c: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          on.delete(w);
          c.push(w);
        } while (w !== v);
        if (c.length > 1 || graph.get(v)!.includes(v)) cycles.push(c.sort());
      }
    };
    for (const f of graph.keys()) if (inside(f) && !index.has(f)) visit(f);
    expect(cycles).toEqual([]);
  });
});

describe('工具表的登记（第六十九轮）', () => {
  it('引用 register-all 以后：部件都登记了，每个工具都接上了做什么', async () => {
    await import('./register-all');
    const { PANEL_KEYS, registeredPanels } = await import('./defs/panel-registry');
    const { CATEGORIES, TOOL_DEFS } = await import('./defs/tools');
    expect([...registeredPanels()].sort()).toEqual([...PANEL_KEYS].sort());
    for (const d of Object.values(TOOL_DEFS)) expect([d.id, typeof d.create]).toEqual([d.id, 'function']);
    // 工具表里写的部件名、“⋯”的设置都在登记的里面
    const keys = new Set<string>(PANEL_KEYS);
    for (const c of CATEGORIES) if (c.extras) expect(keys.has(c.extras)).toBe(true);
  });
});

describe('界面的分层（第七十轮）', () => {
  it('panels/ 只经 tools/api.ts、tools/public.ts 用工具', () => {
    expect(edges((f, d) => f.startsWith('src/ui/panels/') && isTools(d) && d !== 'src/ui/tools/api.ts' && d !== 'src/ui/tools/public.ts')).toEqual([]);
    // 对照：面板确实用到了公开的那几样
    expect(graph.get('src/ui/panels/culture.tsx')).toContain('src/ui/tools/public.ts');
  });

  it('shell/ 不引用具体的档案', () => {
    expect(edges((f, d) => f.startsWith('src/ui/shell/') && isArchive(d))).toEqual([]);
    expect(graph.get('src/ui/shell/Sheet.tsx')).toContain('src/ui/defs/archive-registry.ts');
  });

  it('界面只经 state.ts 引用状态', () => {
    expect(edges((f, d) => f.startsWith('src/ui/') && d.startsWith('src/state/'))).toEqual([]);
  });

  it('domain/ 不引用 panels/、shell/、tools/、river/ 和 .tsx', () => {
    expect(edges((f, d) => f.startsWith('src/ui/domain/') && (/^src\/ui\/(panels|shell|river)\//.test(d) || isTools(d) || d.endsWith('.tsx')))).toEqual([]);
    expect([...graph.keys()].filter((f) => f.startsWith('src/ui/domain/')).length).toBeGreaterThan(10);
  });

  it('引用 register-all 以后：抽屉里的四种档案都登记了', async () => {
    await import('./register-all');
    const { SHEET_KINDS, archiveOf, registeredArchives } = await import('./defs/archive-registry');
    expect([...registeredArchives()].sort()).toEqual([...SHEET_KINDS].sort());
    expect(archiveOf('species').title()).toBe('生态类型');
    expect(archiveOf('country').title()).toBe('国家档案');
  });
});
