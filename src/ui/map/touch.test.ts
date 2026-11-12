import { describe, expect, it } from 'vitest';
import { DRAW_SLOP_PX, LONG_PRESS_MS, PALM_GUARD_MS, PEN_SLOP_PX, PINCH_MIN_PX, TAP_SLOP_PX, TOOL_DELAY_MS, type TouchAct, TouchGestures, type TouchRole } from './touch';

// 第一百轮：手势的判定是纯的状态机——合成的指针序列进去，要做的事出来。时刻都是手写的数，不等真的时钟

// 一次手势的记录：进去的每一下之后出来的事，写成短的字
function rig(role: TouchRole = 'drag') {
  const g = new TouchGestures();
  let asked = 0;
  const roleOf = () => {
    asked++;
    return role;
  };
  const text = (acts: TouchAct[]) =>
    acts.map((a) => {
      const at = 'x' in a ? ` ${a.x},${a.y}` : '';
      const scale = a.do === 'pinch-move' ? ` ×${Number(a.scale.toFixed(4))}` : '';
      const press = (a.do === 'draw-start' || a.do === 'draw-move') && a.pressure !== undefined ? ` p${a.pressure}` : '';
      return `${a.do}${at}${scale}${press}`;
    });
  return {
    g,
    asked: () => asked,
    down: (id: number, x: number, y: number, t: number, pen = false, pressure?: number) => text(g.down({ id, pen, x, y, t, pressure }, roleOf)),
    move: (id: number, x: number, y: number, t: number, pen = false, pressure?: number) => text(g.move({ id, pen, x, y, t, pressure })),
    up: (id: number, x: number, y: number, t: number, pen = false) => text(g.up({ id, pen, x, y, t })),
    cancel: (id: number, x: number, y: number, t: number, pen = false) => text(g.cancel({ id, pen, x, y, t })),
    tick: (t: number) => text(g.tick(t)),
    abort: () => text(g.abort()),
  };
}

describe('阈值', () => {
  it('有名字、彼此说得通', () => {
    expect(TOOL_DELAY_MS).toBeGreaterThan(0);
    // 等着交给工具的时间比长按短得多：按住画笔很快就开始画
    expect(TOOL_DELAY_MS).toBeLessThan(LONG_PRESS_MS / 2);
    expect(DRAW_SLOP_PX).toBeLessThan(TAP_SLOP_PX);
    expect(PEN_SLOP_PX).toBeLessThanOrEqual(TAP_SLOP_PX);
    expect(PINCH_MIN_PX).toBeGreaterThan(0);
    expect(PALM_GUARD_MS).toBeGreaterThan(0);
  });
});

describe('一根手指 · 拖的工具', () => {
  it('按下先等一下，到点了从落下的地方开始画；移动接着画；抬起画完、预览去掉', () => {
    const r = rig('drag');
    expect(r.down(1, 100, 100, 0)).toEqual([]);
    expect(r.asked()).toBe(1);
    expect(r.g.wake()).toBe(TOOL_DELAY_MS);
    expect(r.tick(TOOL_DELAY_MS - 1)).toEqual([]);
    expect(r.tick(TOOL_DELAY_MS)).toEqual(['draw-start 100,100']);
    expect(r.g.wake()).toBeNull();
    expect(r.move(1, 120, 110, 100)).toEqual(['draw-move 120,110']);
    expect(r.up(1, 130, 115, 200)).toEqual(['draw-end 130,115', 'leave']);
    expect(r.g.busy).toBe(false);
    expect(r.g.tracks(1)).toBe(false);
  });

  it('等的时候挪开了：不等满，从落下的地方起笔、接着到现在的位置', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    // 没挪出去：预览跟着手指
    expect(r.move(1, 100 + DRAW_SLOP_PX, 100, 10)).toEqual([`hover ${100 + DRAW_SLOP_PX},100`]);
    expect(r.move(1, 100 + DRAW_SLOP_PX + 1, 100, 20)).toEqual(['draw-start 100,100', `draw-move ${100 + DRAW_SLOP_PX + 1},100`]);
    expect(r.tick(TOOL_DELAY_MS)).toEqual([]);
  });

  it('点一下（没等满就抬起）：一笔从落下到抬起，照样算', () => {
    const r = rig('drag');
    r.down(1, 50, 60, 0);
    expect(r.up(1, 51, 60, 30)).toEqual(['draw-start 50,60', 'draw-end 51,60', 'leave']);
    expect(r.g.busy).toBe(false);
  });

  it('到点时手指已经挪了一点（没出去）：起笔后接着到现在的位置', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.move(1, 102, 101, 40);
    expect(r.tick(TOOL_DELAY_MS)).toEqual(['draw-start 100,100', 'draw-move 102,101']);
  });

  it('按住再久也不是长按：按住画笔是预览', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.tick(TOOL_DELAY_MS);
    expect(r.tick(LONG_PRESS_MS * 3)).toEqual([]);
    expect(r.up(1, 100, 100, LONG_PRESS_MS * 3 + 1)).toEqual(['draw-end 100,100', 'leave']);
  });
});

describe('一根手指 · 点的工具', () => {
  it('点一下是工具的点击', () => {
    const r = rig('click');
    expect(r.down(1, 10, 20, 0)).toEqual([]);
    expect(r.g.wake()).toBe(LONG_PRESS_MS);
    // 手抖：没出去不算拖
    expect(r.move(1, 10 + TAP_SLOP_PX, 20, 50)).toEqual([]);
    expect(r.up(1, 12, 21, 120)).toEqual(['tap 12,21', 'leave']);
  });

  it('拖开了是平移：按下的那一点跟着手指', () => {
    const r = rig('click');
    r.down(1, 10, 20, 0);
    expect(r.move(1, 10 + TAP_SLOP_PX + 1, 20, 50)).toEqual(['leave', 'pan-start 10,20', `pan-move ${10 + TAP_SLOP_PX + 1},20`]);
    expect(r.move(1, 60, 40, 80)).toEqual(['pan-move 60,40']);
    expect(r.up(1, 60, 40, 120)).toEqual(['pan-end']);
    // 平移过了，到点也不算长按
    expect(r.tick(LONG_PRESS_MS)).toEqual([]);
  });

  it('按住不动是长按：钉住落下的地方；之后到抬起为止什么都不做', () => {
    const r = rig('click');
    r.down(1, 10, 20, 0);
    r.move(1, 13, 22, 100);
    expect(r.tick(LONG_PRESS_MS - 1)).toEqual([]);
    expect(r.tick(LONG_PRESS_MS)).toEqual(['leave', 'pin 10,20']);
    expect(r.g.wake()).toBeNull();
    expect(r.move(1, 200, 200, 600)).toEqual([]);
    expect(r.up(1, 200, 200, 700)).toEqual([]);
    expect(r.g.busy).toBe(false);
  });
});

describe('两根手指', () => {
  it('捏合：中点跟着走，倍数是这一下相对上一下', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    // 第二根在等的时候落下：工具一下都没碰，只去掉预览
    expect(r.down(2, 200, 100, 30)).toEqual(['leave', 'pinch-start 150,100']);
    expect(r.asked()).toBe(1);
    expect(r.tick(TOOL_DELAY_MS)).toEqual([]);
    expect(r.move(2, 300, 100, 50)).toEqual(['pinch-move 200,100 ×2']);
    expect(r.move(1, 150, 100, 60)).toEqual(['pinch-move 225,100 ×0.75']);
    // 一起往下挪：只平移
    expect(r.move(1, 150, 140, 70)).toEqual([`pinch-move 225,120 ×${Number((Math.hypot(150, 40) / 150).toFixed(4))}`]);
  });

  it('抬起一根：到此为止；剩下的那根不拿来画，全部抬起以后才回到工具', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.down(2, 200, 100, 10);
    expect(r.up(2, 200, 100, 100)).toEqual(['pinch-end']);
    expect(r.g.busy).toBe(true);
    expect(r.move(1, 150, 150, 120)).toEqual([]);
    expect(r.tick(1000)).toEqual([]);
    expect(r.up(1, 150, 150, 1100)).toEqual([]);
    expect(r.g.busy).toBe(false);
    // 下一次落下才又是工具
    r.down(3, 10, 10, 2000);
    expect(r.tick(2000 + TOOL_DELAY_MS)).toEqual(['draw-start 10,10']);
  });

  it('抬起一根又落下一根：接着平移缩放', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.down(2, 200, 100, 10);
    r.up(2, 200, 100, 100);
    expect(r.down(3, 100, 200, 150)).toEqual(['pinch-start 100,150']);
    expect(r.move(3, 100, 300, 160)).toEqual(['pinch-move 100,200 ×2']);
  });

  it('画到一半第二根手指落下：这一笔不算，改成平移缩放', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.tick(TOOL_DELAY_MS);
    r.move(1, 140, 100, 150);
    expect(r.down(2, 240, 100, 200)).toEqual(['draw-cancel', 'leave', 'pinch-start 190,100']);
    expect(r.move(1, 140, 120, 220)).toEqual([`pinch-move 190,110 ×${Number((Math.hypot(100, 20) / 100).toFixed(4))}`]);
    expect(r.up(1, 140, 120, 300)).toEqual(['pinch-end']);
    // 没有 draw-end：这一笔没有发出去
    expect(r.up(2, 240, 100, 320)).toEqual([]);
    expect(r.g.busy).toBe(false);
  });

  it('一指平移时第二根落下：平移收尾，改成两指', () => {
    const r = rig('click');
    r.down(1, 100, 100, 0);
    r.move(1, 150, 100, 20);
    expect(r.down(2, 250, 100, 40)).toEqual(['pan-end', 'pinch-start 200,100']);
  });

  it('点的工具按着没动时第二根落下：不点、不长按', () => {
    const r = rig('click');
    r.down(1, 100, 100, 0);
    expect(r.down(2, 200, 100, 40)).toEqual(['leave', 'pinch-start 150,100']);
    expect(r.tick(LONG_PRESS_MS)).toEqual([]);
    expect(r.up(1, 100, 100, 600)).toEqual(['pinch-end']);
    expect(r.up(2, 200, 100, 610)).toEqual([]);
  });

  it('两指靠得太近时不算缩放', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.down(2, 100 + PINCH_MIN_PX - 2, 100, 10);
    expect(r.move(2, 100 + PINCH_MIN_PX - 1, 100, 20)[0]).toMatch(/×1$/);
    // 拉开过了那个距离的这一下也还不算（上一下的距离太小），再下一下才算
    expect(r.move(2, 100 + 4 * PINCH_MIN_PX, 100, 30)[0]).toMatch(/×1$/);
    expect(r.move(2, 100 + 8 * PINCH_MIN_PX, 100, 40)[0]).toMatch(/×2$/);
  });

  it('第三根手指不算；两指里的一根抬起就停', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.down(2, 200, 100, 10);
    expect(r.down(3, 300, 300, 20)).toEqual([]);
    expect(r.move(3, 310, 300, 30)).toEqual([]);
    expect(r.up(3, 310, 300, 40)).toEqual([]);
    expect(r.move(2, 300, 100, 50)).toEqual(['pinch-move 200,100 ×2']);
    expect(r.up(1, 100, 100, 60)).toEqual(['pinch-end']);
  });
});

describe('pointercancel（系统手势、来电、切应用）', () => {
  it('画着被拿走：这一笔不算，不卡在按着', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.tick(TOOL_DELAY_MS);
    r.move(1, 150, 100, 100);
    expect(r.cancel(1, 150, 100, 120)).toEqual(['draw-cancel', 'leave']);
    expect(r.g.busy).toBe(false);
    expect(r.g.tracks(1)).toBe(false);
    // 之后还能接着画
    r.down(2, 10, 10, 500);
    expect(r.up(2, 10, 10, 520)).toEqual(['draw-start 10,10', 'draw-end 10,10', 'leave']);
  });

  it('等着、按着没动被拿走：不点、不画，只去掉预览', () => {
    const a = rig('drag');
    a.down(1, 100, 100, 0);
    expect(a.cancel(1, 100, 100, 20)).toEqual(['leave']);
    expect(a.tick(TOOL_DELAY_MS)).toEqual([]);
    const b = rig('click');
    b.down(1, 100, 100, 0);
    expect(b.cancel(1, 100, 100, 20)).toEqual(['leave']);
    expect(b.tick(LONG_PRESS_MS)).toEqual([]);
  });

  it('平移、两指被拿走：收尾', () => {
    const a = rig('click');
    a.down(1, 100, 100, 0);
    a.move(1, 150, 100, 20);
    expect(a.cancel(1, 150, 100, 30)).toEqual(['pan-end']);
    const b = rig('drag');
    b.down(1, 100, 100, 0);
    b.down(2, 200, 100, 10);
    expect(b.cancel(1, 100, 100, 30)).toEqual(['pinch-end']);
    expect(b.cancel(2, 200, 100, 30)).toEqual([]);
    expect(b.g.busy).toBe(false);
  });
});

describe('笔', () => {
  it('笔落下马上是工具（不等），带着压力', () => {
    const r = rig('drag');
    expect(r.down(7, 100, 100, 0, true, 0.4)).toEqual(['draw-start 100,100 p0.4']);
    expect(r.g.penDown).toBe(true);
    expect(r.move(7, 110, 100, 10, true, 0.8)).toEqual(['draw-move 110,100 p0.8']);
    expect(r.up(7, 120, 100, 20, true)).toEqual(['draw-end 120,100', 'leave']);
    expect(r.g.penDown).toBe(false);
  });

  it('笔落着时落下的手指不算（手掌），到它抬起为止', () => {
    const r = rig('drag');
    r.down(7, 100, 100, 0, true, 0.5);
    expect(r.down(1, 300, 300, 10)).toEqual([]);
    expect(r.g.tracks(1)).toBe(true);
    expect(r.move(1, 320, 300, 20)).toEqual([]);
    expect(r.move(7, 110, 100, 30, true, 0.5)).toEqual(['draw-move 110,100 p0.5']);
    expect(r.up(7, 110, 100, 40, true)).toEqual(['draw-end 110,100', 'leave']);
    // 笔抬起了，手掌还搁着：还是不算
    expect(r.move(1, 330, 300, 50)).toEqual([]);
    expect(r.up(1, 330, 300, 60)).toEqual([]);
    expect(r.g.tracks(1)).toBe(false);
  });

  it('笔刚抬起时落下的手指不算；过了那一会儿才算', () => {
    const r = rig('drag');
    r.down(7, 100, 100, 0, true);
    r.up(7, 100, 100, 100, true);
    expect(r.down(1, 300, 300, 100 + PALM_GUARD_MS - 1)).toEqual([]);
    expect(r.tick(100 + PALM_GUARD_MS + TOOL_DELAY_MS)).toEqual([]);
    r.up(1, 300, 300, 600);
    r.down(2, 300, 300, 100 + PALM_GUARD_MS + 600);
    expect(r.tick(100 + PALM_GUARD_MS + 600 + TOOL_DELAY_MS)).toEqual(['draw-start 300,300']);
  });

  it('手指画着时笔落下：手指的那一笔不算，笔接着画；那根手指到抬起为止不算', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.tick(TOOL_DELAY_MS);
    expect(r.down(7, 400, 400, 200, true, 0.3)).toEqual(['draw-cancel', 'leave', 'draw-start 400,400 p0.3']);
    expect(r.move(1, 150, 100, 210)).toEqual([]);
    expect(r.up(1, 150, 100, 220)).toEqual([]);
    expect(r.up(7, 410, 400, 230, true)).toEqual(['draw-end 410,400', 'leave']);
  });

  it('两指平移缩放时笔落下：收尾，笔是工具', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.down(2, 200, 100, 10);
    expect(r.down(7, 400, 400, 50, true)).toEqual(['pinch-end', 'draw-start 400,400']);
    expect(r.move(2, 300, 100, 60)).toEqual([]);
  });

  it('笔拿着点的工具：点一下是点击，拖开是平移（和鼠标一样的 5 像素），按住不动是长按', () => {
    const a = rig('click');
    a.down(7, 10, 10, 0, true);
    expect(a.up(7, 11, 10, 50, true)).toEqual(['tap 11,10', 'leave']);
    const b = rig('click');
    b.down(7, 10, 10, 0, true);
    expect(b.move(7, 10 + PEN_SLOP_PX, 10, 10, true)).toEqual([]);
    expect(b.move(7, 10 + PEN_SLOP_PX + 1, 10, 20, true)).toEqual(['leave', 'pan-start 10,10', `pan-move ${10 + PEN_SLOP_PX + 1},10`]);
    const c = rig('click');
    c.down(7, 10, 10, 0, true);
    expect(c.tick(LONG_PRESS_MS)).toEqual(['leave', 'pin 10,10']);
    // 笔还落着：到抬起为止不算
    expect(c.move(7, 50, 50, 600, true)).toEqual([]);
    expect(c.up(7, 50, 50, 700, true)).toEqual([]);
    expect(c.g.tracks(7)).toBe(false);
  });
});

describe('手指只移动地图（拿着拖的工具、手指不画）', () => {
  it('拖是平移，点一下什么都不做，按住不动是长按', () => {
    const a = rig('none');
    expect(a.down(1, 100, 100, 0)).toEqual([]);
    expect(a.tick(TOOL_DELAY_MS)).toEqual([]);
    expect(a.move(1, 100 + TAP_SLOP_PX + 5, 100, 100)).toEqual(['pan-start 100,100', `pan-move ${100 + TAP_SLOP_PX + 5},100`]);
    expect(a.up(1, 120, 100, 150)).toEqual(['pan-end']);
    const b = rig('none');
    b.down(1, 100, 100, 0);
    expect(b.up(1, 100, 100, 50)).toEqual([]);
    const c = rig('none');
    c.down(1, 100, 100, 0);
    expect(c.tick(LONG_PRESS_MS)).toEqual(['pin 100,100']);
  });

  it('两指照常平移缩放', () => {
    const r = rig('none');
    r.down(1, 100, 100, 0);
    expect(r.down(2, 200, 100, 10)).toEqual(['pinch-start 150,100']);
  });
});

describe('Esc（外接键盘）、换了世界', () => {
  it('画着时取消：这一笔不算；手指到抬起为止不再算', () => {
    const r = rig('drag');
    r.down(1, 100, 100, 0);
    r.tick(TOOL_DELAY_MS);
    expect(r.abort()).toEqual(['draw-cancel', 'leave']);
    expect(r.move(1, 200, 100, 200)).toEqual([]);
    expect(r.up(1, 200, 100, 300)).toEqual([]);
    expect(r.g.busy).toBe(false);
  });

  it('笔画着时取消：笔到抬起为止不再算', () => {
    const r = rig('drag');
    r.down(7, 100, 100, 0, true);
    expect(r.abort()).toEqual(['draw-cancel', 'leave']);
    expect(r.g.tracks(7)).toBe(true);
    expect(r.move(7, 200, 100, 200, true)).toEqual([]);
    expect(r.up(7, 200, 100, 300, true)).toEqual([]);
    expect(r.g.tracks(7)).toBe(false);
  });

  it('没有手势时取消：什么都不做', () => {
    expect(rig().abort()).toEqual([]);
  });
});

describe('随便怎么来都不卡住', () => {
  it('一长串随机的按下、移动、抬起、取消之后，全部抬起就回到空闲；每一笔要么画完要么取消', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const role of ['drag', 'click', 'none'] as const) {
      const r = rig(role);
      const downIds = new Set<number>();
      let t = 0;
      let open = 0;
      let pans = 0;
      const see = (acts: string[]) => {
        for (const a of acts) {
          if (a.startsWith('draw-start')) open++;
          if (a.startsWith('draw-end') || a === 'draw-cancel') open--;
          if (a.startsWith('pan-start') || a.startsWith('pinch-start')) pans++;
          if (a === 'pan-end' || a === 'pinch-end') pans--;
          expect(open).toBeGreaterThanOrEqual(0);
          expect(open).toBeLessThanOrEqual(1);
          expect(pans).toBeGreaterThanOrEqual(0);
          expect(pans).toBeLessThanOrEqual(1);
          // 画着的时候不平移，平移的时候不画
          expect(open + pans).toBeLessThanOrEqual(1);
        }
      };
      for (let k = 0; k < 4000; k++) {
        t += Math.floor(rand() * 120);
        const id = 1 + Math.floor(rand() * 5);
        const pen = id === 5;
        const x = Math.floor(rand() * 400);
        const y = Math.floor(rand() * 300);
        const roll = rand();
        if (roll < 0.25 && !downIds.has(id)) {
          downIds.add(id);
          see(r.down(id, x, y, t, pen, 0.5));
        } else if (roll < 0.7) {
          if (downIds.has(id)) see(r.move(id, x, y, t, pen, 0.5));
        } else if (roll < 0.85) {
          if (downIds.delete(id)) see(r.up(id, x, y, t, pen));
        } else if (roll < 0.9) {
          if (downIds.delete(id)) see(r.cancel(id, x, y, t, pen));
        } else if (roll < 0.98) see(r.tick(t));
        else see(r.abort());
      }
      for (const id of downIds) see(r.up(id, 0, 0, t + 1, id === 5));
      expect(open).toBe(0);
      expect(pans).toBe(0);
      expect(r.g.busy).toBe(false);
      expect(r.g.wake()).toBeNull();
      for (let id = 1; id <= 5; id++) expect(r.g.tracks(id)).toBe(false);
    }
  });
});
