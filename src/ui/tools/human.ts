import type { Command } from '../../../core/commands';
import { hexToRgb } from '../../../core/export';
import { RESOURCE_NONE, classAt, resourceAt, terrainLabel, worldResources, worldTerrainClasses } from '../../../core/human';
import { groundUnder } from '../../../core/human/class-ground';
import type { World } from '../../../core/world';
import { NO_RESOURCE } from '../../render/colors';
import { exec, options, setOptions, world } from '../../state';
import { type RGB, type ToolHandler, WHITE } from './api';
import { type Stroke, brushTool } from './brush';

// 画地形类别、资源（第二十一轮）：按住涂陆地格，换成底部条上选的那一种；“恢复自动”去掉画过的。
// 资源、力度 0 的类别只改这一层；类别的力度大于 0 时地面跟着升降到典型高度（第五十八轮，core/human/class-ground.ts）

// 能画的格：干的陆地（陆地、不是湖面）
export const dryLand = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;

// 选着的类别（'' 恢复自动；世界里没有这一类时为 undefined）
export function chosenClass(w: World): { id: string | null; name: string; color: RGB } | undefined {
  const id = options.value.terrainClass;
  if (!id) return { id: null, name: '恢复自动', color: WHITE };
  const c = worldTerrainClasses(w.small).find((x) => x.id === id);
  return c ? { id: c.id, name: c.name, color: hexToRgb(c.color) } : undefined;
}

// 选着的资源（'' 恢复自动，'none' 无）
export function chosenResource(w: World): { id: string | null; name: string; color: RGB } | undefined {
  const id = options.value.resource;
  if (!id) return { id: null, name: '恢复自动', color: WHITE };
  if (id === 'none') return { id: 'none', name: '无', color: NO_RESOURCE };
  const r = worldResources(w.small).find((x) => x.id === id);
  return r ? { id: r.id, name: r.name, color: hexToRgb(r.color) } : undefined;
}

// 涂类别（橡皮擦也是它）：力度 0 时和以前的命令一字不差
export const classCommand = (s: { cells: number[]; ts: number[] }, id: string | null): Command => {
  const strength = options.value.classStrength;
  return strength > 0 ? { op: 'set_cell_class', cells: s.cells, class: id, strength, t: s.ts } : { op: 'set_cell_class', cells: s.cells, class: id };
};
const resourceCommand = (s: { cells: number[] }, id: string | null): Command => ({ op: 'set_cell_resource', cells: s.cells, resource: id });

// 这一笔之后地面往哪里去（鼠标旁的一句话）：力度 0、这一类没写典型高度时不说
function groundHint(w: World, s: Stroke): string {
  if (!(options.value.classStrength > 0) || !s.t.size) return '';
  const id = options.value.terrainClass;
  if (!id) return ' · 地面回到生成时';
  const height = worldTerrainClasses(w.small).find((c) => c.id === id)?.height;
  if (height === undefined) return '';
  const now = groundUnder(s.cells, s.ts, w.derived.elevation);
  return ` · 地面现在约 ${Math.round(now).toLocaleString()} m，向 ${height.toLocaleString()} m`;
}

// 画笔圈住的格里：鼠标下这一格现在是什么
function classHere(w: World, cell: number): string | null {
  if (cell < 0 || !dryLand(w, cell)) return null;
  const c = classAt(w.small, w.derived.terrainClass[cell]);
  return c ? `这里：${terrainLabel(w, cell) ?? c.name}${w.causes.terrainClass?.[cell] ? '' : '（自动）'}` : null;
}
function resourceHere(w: World, cell: number): string | null {
  if (cell < 0 || !dryLand(w, cell)) return null;
  const r = resourceAt(w.small, w.derived.resource[cell]);
  const own = (w.causes.resource?.[cell] ?? 0) !== 0;
  return `这里：${r ? r.name : '无'}${own ? '' : '（自动）'}`;
}

function humanBrush(which: 'class' | 'resource'): ToolHandler {
  const chosen = which === 'class' ? chosenClass : chosenResource;
  const command = which === 'class' ? classCommand : resourceCommand;
  const what = which === 'class' ? '地形类别' : '资源';
  const ground = (w: World, s: Stroke) => (which === 'class' ? groundHint(w, s) : '');
  const label = (w: World) => {
    const c = chosen(w);
    return !c ? '' : c.id === null ? `${what}恢复自动` : which === 'resource' && c.id === 'none' ? '去掉资源' : `${what}“${c.name}”`;
  };
  return brushTool({
    // 选的那一种被停用了：先换一种
    hint: () => {
      const w = world.value;
      return w && !chosen(w) ? { text: `先选一种${what}`, warn: true } : { text: null };
    },
    filter: dryLand,
    here: (w, _cells, p) => (which === 'class' ? classHere(w, p.cell) : resourceHere(w, p.cell)),
    layers(w, s) {
      const c = chosen(w);
      if (!c) return { layers: [], hint: `先选一种${what}`, warn: true };
      return {
        layers: [{ cells: s.cells, color: c.color, alpha: c.id === null ? 0.35 : 0.75 }],
        hint: s.t.size ? `${label(w)} · ${s.t.size} 格${ground(w, s)}` : '这里没有陆地',
        warn: !s.t.size,
      };
    },
    exact: (w, s) => {
      const c = chosen(w);
      return c && s.t.size ? command(s, c.id) : null;
    },
    exactHint: (w, s) => `${label(w)} · ${s.t.size} 格${ground(w, s)}`,
    async commit(w, s) {
      const c = chosen(w);
      if (!c || !s.t.size) return;
      await exec(command(s, c.id), '正在计算…');
    },
  });
}

export const terrainClassTool = (): ToolHandler => humanBrush('class');
export const resourceTool = (): ToolHandler => humanBrush('resource');

// Alt+点：吸取这一格的类别、资源（没有资源的陆地吸取“无”）
export function pickClass(w: World, cell: number): string | null {
  if (!dryLand(w, cell)) return null;
  const c = classAt(w.small, w.derived.terrainClass[cell]);
  if (!c) return null;
  setOptions({ terrainClass: c.id });
  return c.name;
}
export function pickResource(w: World, cell: number): string | null {
  if (!dryLand(w, cell)) return null;
  const code = w.derived.resource[cell];
  const r = code === RESOURCE_NONE ? undefined : resourceAt(w.small, code);
  setOptions({ resource: r ? r.id : 'none' });
  return r ? r.name : '无';
}
