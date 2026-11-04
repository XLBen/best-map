import { builtinPacks } from '../packs/builtin-tree';
import { digest } from '../digest';
import type { Engine } from '../engine';
import type { Command } from '../commands';
import { continents, engineFor, generateHuman } from './fixtures';

// “只改类别”的一串命令的摘要（第五十八轮）：core/human/class-ground.test.ts 拿它和第五十七轮（f01e102）记下的值对照。
// 这个文件也要能在 f01e102 上跑（复制过去，记下 class-only 的值）：只用到那时已有的接口。不要改它，改了要重记。

// 世界的全部：推导、原因；小数据里地形类别的典型高度（第五十八轮加的）不算
function worldDigest(eng: Engine): Record<string, string> {
  const { derived, causes, small } = eng.world;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(derived)) out[`d.${k}`] = digest(ArrayBuffer.isView(v) ? v : JSON.parse(JSON.stringify(v ?? null)));
  for (const [k, v] of Object.entries(causes)) if (ArrayBuffer.isView(v)) out[`c.${k}`] = digest(v);
  out['c.fields'] = digest(Object.entries(causes.fields).map(([k, v]) => [k, v]));
  const classes = Object.fromEntries(
    Object.entries(small.content?.terrainClass ?? {}).map(([id, c]) => {
      const { height: _, ...rest } = c as { height?: number };
      return [id, rest];
    }),
  );
  out.small = digest(JSON.parse(JSON.stringify({ ...small, content: { ...small.content, terrainClass: classes } })));
  return out;
}

// 这一步的历史：说明、重算到哪一层、撤销的数组（撤销记录里别的是小数据的副本，上面已经比了；命令只比格，加进去的字段不算）
function stepDigest(eng: Engine): string {
  const done = (eng as unknown as { done: { cmd: { cells?: number[]; class?: string | null }; summary: string; dirty: number; undo: { arrays: { key: string; idx: Int32Array; old: Float64Array }[]; dropArrays?: string[]; dropHeights?: boolean; dropFragment?: boolean } }[] }).done;
  const h = done[done.length - 1];
  const { undo } = h;
  return digest([h.cmd.cells ?? [], h.cmd.class ?? '', h.summary, h.dirty, undo.arrays.flatMap((a) => [a.key, a.idx, a.old]), undo.dropArrays ?? [], !!undo.dropHeights, !!undo.dropFragment]);
}

function strokes(eng: Engine): Command[] {
  const { causes, mesh } = eng.world;
  const land: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (causes.land[i]) land.push(i);
  const sea: number[] = [];
  for (let i = 0; i < mesh.n && sea.length < 20; i++) if (!causes.land[i]) sea.push(i);
  return [
    { op: 'set_cell_class', cells: land.slice(0, 400), class: 'hills' },
    { op: 'set_cell_class', cells: [...land.slice(200, 500), ...sea], class: 'mountains' },
    { op: 'set_cell_class', cells: land.slice(300, 350), class: null },
    { op: 'set_cell_class', cells: land.slice(0, 20), class: 'forest' },
  ];
}

// 一串只改类别的命令：每一步之后世界的摘要、这一步的历史，再一步一步撤销回去。
// more 加进每条命令（第五十八轮的测试：strength: 0 与不写要逐位相同）
export function classOnlyDigests(eng: Engine, more: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (label: string) => {
    out[label] = digest(Object.entries(worldDigest(eng)));
  };
  put('0');
  const list = strokes(eng);
  list.forEach((c, k) => {
    eng.exec({ ...c, ...more } as Command);
    put(String(k + 1));
    out[`${k + 1}.step`] = stepDigest(eng);
  });
  for (let k = list.length; k > 0; k--) {
    eng.undo();
    put(`u${k}`);
  }
  return out;
}

export function humanRegion(): Engine {
  const eng = continents({ cells: 6000, provinces: true });
  const groups = ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => ({ id: n.id, weight: n.weight ?? 1 }));
  generateHuman(eng, 'medieval', groups, { countries: {} });
  return eng;
}

export function smallGlobe(): Engine {
  const eng = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 });
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
  return eng;
}
