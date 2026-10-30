import { describe, expect, it } from 'vitest';
import { traceRivers } from '../../core/rivers';
import { continents } from '../../core/testing/fixtures';
import { riverAt, stemOf } from './river/query';

// 第三十三轮：三角洲分出去的几股（只是画法）。点分出去的一股选中的是主流（同一条河），不是另一条河

describe('三角洲的分汊', () => {
  it('点分出去的一股（离主流远的那一段）选中主流', () => {
    const w = continents().world;
    const lines = traceRivers(w);
    const branches = lines.filter((l) => l.branch !== undefined);
    expect(branches.length).toBeGreaterThan(0);
    const tol = w.mesh.spacing * 0.05;
    let checked = 0;
    for (const b of branches) {
      const M = lines[b.branch!];
      const mouth = M.cells![M.cells!.length - 1];
      const mainStem = stemOf(w, mouth).cells;
      // 分出去的一股靠近河口的那一点（最后两成：离主流至少 0.3 格）
      const p = b.points[Math.floor(b.points.length * 0.85)];
      const hit = riverAt(w, p[0], p[1], tol);
      expect(hit).not.toBeNull();
      expect(hit!.ref.kind).toBe('natural');
      if (hit!.ref.kind !== 'natural') continue;
      // 选中的这条河就是主流（同一条主干）
      expect(stemOf(w, hit!.ref.cell).cells).toEqual(mainStem);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
