// 触摸与笔的手势（第一百轮）：纯的状态机——不碰 DOM、时钟、工具、镜头。进来的是手指 / 笔的按下、移动、抬起、取消
// 和“到点了”（tick），出去的是一串要做的事（TouchAct），由 touch-wire.ts 接到工具和镜头上。鼠标不经过这里。
//
// 规则（帮助、使用说明里写的就是这几条）：
//   · 一根手指用工具：拖的工具是画，点的工具点一下是点、拖是平移（和鼠标左键一样）；
//   · 两根手指平移和捏合缩放（同时）；
//   · 画到一半第二根手指落下：这一笔不算，改成平移缩放；全部手指抬起以后才回到工具；
//   · 长按：手指这时不是在画（拿着点的工具，或开了“手指只移动地图”）时，按住不动 LONG_PRESS_MS 是钉住“这里”；
//   · 笔永远是用工具；笔落着、刚抬起时落下的手指不算（手掌）；
//   · 系统把手势拿走了（pointercancel）：当作取消，不留半笔。

// ---------- 阈值 ----------

// 一根手指落下后先等这么久（毫秒）才把它交给拖的工具：第二根手指多半在这之内落下，这样捏合不会先闪一下画笔、也不用取消。
// 等的时候挪动超过 DRAW_SLOP_PX、或者手指抬起（点一下），马上交给工具，不等满
export const TOOL_DELAY_MS = 80;
// 等的时候手指挪动超过这么多（CSS 像素）就开始画
export const DRAW_SLOP_PX = 4;
// 手指：挪动不超过这么多算没动（点一下、长按）；点的工具拖过了它是平移。鼠标是 5（map/input.ts），手指抖得多些
export const TAP_SLOP_PX = 10;
// 笔：同上，和鼠标一样
export const PEN_SLOP_PX = 5;
// 按住不动这么久是长按
export const LONG_PRESS_MS = 500;
// 笔抬起后这么久之内落下的手指不算（写字的手掌）
export const PALM_GUARD_MS = 300;
// 两指靠得比这近时不算缩放（只平移）：距离太小，一点抖动就是好几倍
export const PINCH_MIN_PX = 12;

// ---------- 进来的、出去的 ----------

// 这一根手指 / 笔落下时拿它做什么（由接线的一方按当前工具、偏好定）：
//   drag  拖的工具：按下就是画
//   click 点的工具：点一下是工具的点击，拖是平移地图
//   none  拿的是拖的工具，但开了“手指只移动地图”：手指不画，只平移
export type TouchRole = 'drag' | 'click' | 'none';

export interface TouchEv {
  // 指针的编号（PointerEvent.pointerId）
  id: number;
  pen: boolean;
  // CSS 像素，相对画布
  x: number;
  y: number;
  // 毫秒（和 tick 用同一个时钟）
  t: number;
  // 笔的压力 0–1（手指不看）
  pressure?: number;
}

export type TouchAct =
  // 悬停一样的预览：手指按下时工具照常有预览（画笔圈、这是哪个省）
  | { do: 'hover'; x: number; y: number }
  // 预览去掉（手指抬起以后不留一个停在最后位置的圈）
  | { do: 'leave' }
  // 拖的工具：开始一笔、接着画、画完、这一笔不算
  | { do: 'draw-start'; x: number; y: number; pressure?: number }
  | { do: 'draw-move'; x: number; y: number; pressure?: number }
  | { do: 'draw-end'; x: number; y: number }
  | { do: 'draw-cancel' }
  // 点的工具：点一下
  | { do: 'tap'; x: number; y: number }
  // 长按：钉住这里
  | { do: 'pin'; x: number; y: number }
  // 一根手指平移（按下的那一点跟着手指）
  | { do: 'pan-start'; x: number; y: number }
  | { do: 'pan-move'; x: number; y: number }
  | { do: 'pan-end' }
  // 两根手指：中点跟着走，scale 是这一下相对上一下放大了几倍
  | { do: 'pinch-start'; x: number; y: number }
  | { do: 'pinch-move'; x: number; y: number; scale: number }
  | { do: 'pinch-end' };

type Mode = 'idle' | 'wait' | 'draw' | 'pan' | 'pinch' | 'spent';

interface Primary {
  id: number;
  pen: boolean;
  role: TouchRole;
  // 落下的地方、时刻
  x0: number;
  y0: number;
  t0: number;
  // 现在在哪
  x: number;
  y: number;
  pressure?: number;
}

export class TouchGestures {
  private mode: Mode = 'idle';
  private primary: Primary | null = null;
  // 落着的、算数的手指（不算被当成手掌的）
  private fingers = new Map<number, { x: number; y: number }>();
  // 落着但不算的：笔落着、刚抬起时落下的手指，笔落下时已经在的手指，被取消的（Esc）
  private ignored = new Set<number>();
  // 两指：是哪两根、上一次相距多远
  private pinch: { a: number; b: number; dist: number } | null = null;
  // 笔上一次抬起的时刻
  private penUp = Number.NEGATIVE_INFINITY;

  // 这个指针是不是在这里记着（落着的手指、笔；包括不算的）。没记着的移动是笔的悬停，交给鼠标那一条路
  tracks(id: number): boolean {
    return this.fingers.has(id) || this.ignored.has(id) || this.primary?.id === id;
  }
  // 有没有手势正在进行（有就不让鼠标、笔的悬停插进来）
  get busy(): boolean {
    return this.mode !== 'idle';
  }
  // 笔是不是落着
  get penDown(): boolean {
    return !!this.primary?.pen;
  }
  // 下一次要在什么时刻 tick（没有要等的时 null）：等着交给拖的工具、等着算长按
  wake(): number | null {
    const p = this.primary;
    if (this.mode !== 'wait' || !p) return null;
    return p.t0 + (p.role === 'drag' ? TOOL_DELAY_MS : LONG_PRESS_MS);
  }

  // role：只在这一根要当主角（用工具、平移、长按）时才问一次；问的时候接线的一方顺便把悬停的预览放上
  down(e: TouchEv, role: () => TouchRole): TouchAct[] {
    if (this.tracks(e.id)) return [];
    const out: TouchAct[] = [];
    if (e.pen) {
      // 已经有一支笔落着：第二支不算
      if (this.penDown) {
        this.ignored.add(e.id);
        return out;
      }
      // 笔落下：手指正做着的都停下（画着的那一笔不算），这些手指到抬起为止不算
      this.closeGesture(out);
      for (const id of this.fingers.keys()) this.ignored.add(id);
      this.fingers.clear();
      const r = role();
      this.primary = { id: e.id, pen: true, role: r === 'none' ? 'click' : r, x0: e.x, y0: e.y, t0: e.t, x: e.x, y: e.y, pressure: e.pressure };
      if (this.primary.role === 'drag') {
        // 笔不用等：没有“第二支笔”要让
        this.mode = 'draw';
        out.push({ do: 'draw-start', x: e.x, y: e.y, pressure: e.pressure });
      } else this.mode = 'wait';
      return out;
    }
    // 手指。笔落着、刚抬起：当成手掌，到它抬起为止不算
    if (this.penDown || e.t - this.penUp < PALM_GUARD_MS) {
      this.ignored.add(e.id);
      return out;
    }
    this.fingers.set(e.id, { x: e.x, y: e.y });
    if (this.mode === 'idle') {
      this.primary = { id: e.id, pen: false, role: role(), x0: e.x, y0: e.y, t0: e.t, x: e.x, y: e.y };
      this.mode = 'wait';
      return out;
    }
    if (this.mode === 'pinch') return out;
    // 第二根手指落下（等着、画着、平移着、这次手势用完了又凑成两根）：正做着的停下，改成两指的平移缩放
    if (this.fingers.size === 2) {
      this.closeGesture(out);
      this.startPinch(out);
    }
    return out;
  }

  move(e: TouchEv): TouchAct[] {
    const out: TouchAct[] = [];
    const f = this.fingers.get(e.id);
    if (f) {
      f.x = e.x;
      f.y = e.y;
    }
    const p = this.primary;
    if (p && p.id === e.id) {
      p.x = e.x;
      p.y = e.y;
      p.pressure = e.pressure;
      if (this.mode === 'wait') {
        const d = Math.hypot(e.x - p.x0, e.y - p.y0);
        if (p.role === 'drag') {
          if (d > DRAW_SLOP_PX) this.startDraw(out);
          else out.push({ do: 'hover', x: e.x, y: e.y });
        } else if (d > (p.pen ? PEN_SLOP_PX : TAP_SLOP_PX)) {
          // 点的工具（或手指只移动地图）拖开了：平移，按下的那一点跟着手指
          if (p.role !== 'none') out.push({ do: 'leave' });
          this.mode = 'pan';
          out.push({ do: 'pan-start', x: p.x0, y: p.y0 }, { do: 'pan-move', x: e.x, y: e.y });
        }
      } else if (this.mode === 'draw') out.push({ do: 'draw-move', x: e.x, y: e.y, pressure: e.pressure });
      else if (this.mode === 'pan') out.push({ do: 'pan-move', x: e.x, y: e.y });
      return out;
    }
    const pn = this.pinch;
    if (this.mode === 'pinch' && pn && (e.id === pn.a || e.id === pn.b)) {
      const g = this.pinchGeometry();
      if (!g) return out;
      const scale = g.dist >= PINCH_MIN_PX && pn.dist >= PINCH_MIN_PX ? g.dist / pn.dist : 1;
      pn.dist = g.dist;
      out.push({ do: 'pinch-move', x: g.x, y: g.y, scale });
    }
    return out;
  }

  up(e: TouchEv): TouchAct[] {
    return this.lift(e, false);
  }
  // 系统把这个指针拿走了（系统手势、来电、切应用）：和抬起一样收尾，但正做着的不算
  cancel(e: TouchEv): TouchAct[] {
    return this.lift(e, true);
  }

  private lift(e: TouchEv, cancelled: boolean): TouchAct[] {
    const out: TouchAct[] = [];
    if (this.ignored.delete(e.id)) return out;
    const p = this.primary;
    const wasFinger = this.fingers.delete(e.id);
    if (p && p.id === e.id) {
      if (p.pen) this.penUp = e.t;
      if (cancelled) this.closeGesture(out);
      else if (this.mode === 'wait') {
        // 没等满、没拖开就抬起：点一下
        if (p.role === 'drag') out.push({ do: 'draw-start', x: p.x0, y: p.y0, pressure: p.pressure }, { do: 'draw-end', x: e.x, y: e.y }, { do: 'leave' });
        else if (p.role === 'click') out.push({ do: 'tap', x: e.x, y: e.y }, { do: 'leave' });
      } else if (this.mode === 'draw') out.push({ do: 'draw-end', x: e.x, y: e.y }, { do: 'leave' });
      else if (this.mode === 'pan') out.push({ do: 'pan-end' });
      this.primary = null;
      this.mode = 'idle';
      return out;
    }
    if (!wasFinger) return out;
    const pn = this.pinch;
    if (this.mode === 'pinch' && pn && (e.id === pn.a || e.id === pn.b)) {
      // 两指里抬起一根：平移缩放到此为止；剩下的那根不拿来画（全部抬起以后才回到工具）
      out.push({ do: 'pinch-end' });
      this.pinch = null;
      this.mode = 'spent';
    }
    if (this.mode === 'spent' && this.fingers.size === 0) this.mode = 'idle';
    return out;
  }

  // 到点了：等够了交给拖的工具；按住不动够久是长按
  tick(t: number): TouchAct[] {
    const out: TouchAct[] = [];
    const p = this.primary;
    if (this.mode !== 'wait' || !p) return out;
    if (p.role === 'drag') {
      if (t - p.t0 >= TOOL_DELAY_MS) this.startDraw(out);
    } else if (t - p.t0 >= LONG_PRESS_MS) {
      if (p.role !== 'none') out.push({ do: 'leave' });
      out.push({ do: 'pin', x: p.x0, y: p.y0 });
      this.spend();
    }
    return out;
  }

  // Esc、换了世界：正做着的都不算，落着的手指 / 笔到抬起为止不再算
  abort(): TouchAct[] {
    const out: TouchAct[] = [];
    const p = this.primary;
    this.closeGesture(out);
    if (p?.pen) this.ignored.add(p.id);
    return out;
  }

  // ---------- 里面用的 ----------

  // 等着的那一根交给拖的工具：从落下的地方起笔，已经挪开了就接着画到现在的位置
  private startDraw(out: TouchAct[]) {
    const p = this.primary!;
    this.mode = 'draw';
    out.push({ do: 'draw-start', x: p.x0, y: p.y0, pressure: p.pressure });
    if (p.x !== p.x0 || p.y !== p.y0) out.push({ do: 'draw-move', x: p.x, y: p.y, pressure: p.pressure });
  }

  // 正做着的停下（不算）：画着的一笔取消、平移和两指收尾、等着的去掉预览。之后由调用的一方定接下来是什么
  private closeGesture(out: TouchAct[]) {
    const p = this.primary;
    if (this.mode === 'wait' && p && p.role !== 'none') out.push({ do: 'leave' });
    else if (this.mode === 'draw') out.push({ do: 'draw-cancel' }, { do: 'leave' });
    else if (this.mode === 'pan') out.push({ do: 'pan-end' });
    else if (this.mode === 'pinch') out.push({ do: 'pinch-end' });
    this.pinch = null;
    this.primary = null;
    this.mode = this.fingers.size ? 'spent' : 'idle';
  }

  // 这次手势用完了：落着的到抬起为止不再算（笔记进“不算”的里面，手指留着数——再凑成两根还能平移缩放）
  private spend() {
    const p = this.primary;
    if (p?.pen) this.ignored.add(p.id);
    this.primary = null;
    this.pinch = null;
    this.mode = this.fingers.size ? 'spent' : 'idle';
  }

  private pinchGeometry(): { x: number; y: number; dist: number } | null {
    const pn = this.pinch;
    const a = pn && this.fingers.get(pn.a);
    const b = pn && this.fingers.get(pn.b);
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  private startPinch(out: TouchAct[]) {
    const [a, b] = [...this.fingers.keys()];
    this.pinch = { a, b, dist: 0 };
    const g = this.pinchGeometry()!;
    this.pinch.dist = g.dist;
    this.mode = 'pinch';
    out.push({ do: 'pinch-start', x: g.x, y: g.y });
  }
}
