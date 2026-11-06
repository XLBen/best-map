import type { Command } from '../../../core/commands';
import type { PreviewResult } from '../../../core/engine';
import { lakeArea } from '../../../core/elevation';
import { arcUnits } from '../../../core/geo';
import { snapOnto } from '../../../core/rivers';
import { isRiverCell } from '../../../core/select';
import type { World } from '../../../core/world';
import { cancelPreviews, exec, previewCommand, selectedRiver, showToast, world } from '../../state';
import { Settle } from '../domain/exact';
import { EMPTY, type Pointer, type ToolHandler, isBusy } from '../tools';
import { guideName, guideOf, lineOf, quoted } from './query';
import { RED, RED_LINE, lineShapes } from './shapes';

// ---------- 删除河湖 ----------

// 删掉一条画的河：提示条写它的名字（预览与执行同一条命令，执行时直接采用预览）
function removeCmd(w: World, id: string): Command {
  const g = guideOf(w, id);
  return { op: 'remove_guide', id, label: `删除${quoted(g ? guideName(w, g) : null, '画的河')}` };
}

// 删掉画过的河或湖：找离鼠标最近的（屏幕上 12 像素以内；画的河按画出来的线认）。
// 停在同一条河上 300 毫秒后，确切地算出删掉后真正不再是河的格（红色）
export function unwaterTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  const exact = new Settle<PreviewResult>(true);
  const target = (w: World): { kind: 'guide' | 'lake'; id: string; cells: number[] } | null => {
    if (!pointer) return null;
    const { mesh } = w;
    const tol = 12 / zoom();
    let best: { kind: 'guide' | 'lake'; id: string; cells: number[] } | null = null;
    let bd = tol;
    const sphere = mesh.kind === 'sphere';
    for (const l of w.small.lakes) {
      const dd = (sphere ? arcUnits(mesh.x[l.cell], mesh.y[l.cell], pointer.x, pointer.y) : Math.hypot(mesh.x[l.cell] - pointer.x, mesh.y[l.cell] - pointer.y)) - l.radius / w.kmPerUnit;
      if (dd < bd) {
        bd = Math.max(0, dd);
        best = { kind: 'lake', id: l.id, cells: lakeArea(w, l.cell, l.radius) };
      }
    }
    for (const g of w.small.guides) {
      const L = lineOf(w, g);
      const h = snapOnto(L.points, pointer.x, pointer.y, 0, L.points.length - 1, sphere);
      if (h && h.d < bd) {
        bd = h.d;
        best = { kind: 'guide', id: g.id, cells: g.cells };
      }
    }
    return best;
  };
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave() {
      pointer = null;
      exact.reset();
    },
    async click(p) {
      pointer = p;
      const w = world.value;
      if (!w || isBusy()) return;
      const t = target(w);
      if (!t) {
        showToast('这里没有画过的河或湖', true);
        return;
      }
      if (selectedRiver.value?.kind === 'guide' && selectedRiver.value.id === t.id) selectedRiver.value = null;
      exact.hold();
      cancelPreviews();
      try {
        await exec(t.kind === 'guide' ? removeCmd(w, t.id) : { op: 'remove_lake', id: t.id }, '正在计算…');
      } finally {
        exact.reset();
      }
    },
    cancel() {
      exact.reset();
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const t = target(w);
      // 离开了画的河：停在它上面时排着的确切预览不要了
      if (t?.kind !== 'guide') exact.reset();
      if (!t) return EMPTY;
      if (t.kind === 'lake') return { layers: [{ cells: t.cells, color: RED, alpha: 0.7 }], shapes: [], hint: '删除湖' };
      const g = guideOf(w, t.id)!;
      const cmd: Command = removeCmd(w, t.id);
      const key = JSON.stringify(cmd);
      exact.want(key, () => previewCommand(cmd), 300);
      const x = exact.get(key);
      const shapes = lineShapes(w, lineOf(w, g).points, { color: RED_LINE, width: 4 });
      if (!x) return { layers: [], shapes, hint: '删除河' };
      // 删掉后这里还剩多少是河：水本来就会这么流的地方还是河
      const gone = new Set(x.riverRemoved);
      const body = g.cells.filter((c) => isRiverCell(w, w.derived, c));
      const left = body.filter((c) => !gone.has(c)).length;
      return {
        layers: [{ cells: x.riverRemoved, color: RED, alpha: 0.8 }],
        shapes,
        hint: left >= Math.max(2, body.length * 0.3) ? '删除河 · 会剩下自然的河' : '删除河',
      };
    },
  };
}
