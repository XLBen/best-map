import { describe, expect, it, vi } from 'vitest';
import { smallGlobe } from '../../../core/testing/class-only';
import { continents } from '../../../core/testing/fixtures';
import type { World } from '../../../core/world';
import type { ProjCamera } from '../../render/projection';
import { hoverCell, openPanel, picking, pinnedCell, pinnedPart, tool, toast, world } from '../../state';
import { makeRig, recorderTool } from './input-rig';
// 每个工具的吸管（Alt + 点）登记在这里
import '../tools/bind';

// 第一百轮（触摸与平板）：鼠标、触控板、键盘在地图上的行为一项都不变。
// 一串脚本化的鼠标事件（按下、移动、松开、中键右键、空格拖、滚轮、Alt 吸取、离开、Esc 的取消……，几种投影、
// 拖的工具和点的工具各走一遍）交给 map/input.ts，记下调到工具上的每一下、每个事件之后的镜头和钉住的格。
// 录下的那一份（__snapshots__/input-mouse.json）是在第九十九轮的 input.ts 上录的（改它之前），之后不重录：变了就是鼠标的行为变了

// 固定的随机数（mulberry32）
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 800;
const H = 600;
// 鼠标滚轮的一格（Chrome、Safari 在 Mac 上）
const NOTCH = 4.000244140625;

interface Scene {
  name: string;
  world: () => World;
  camera: () => ProjCamera;
  drags: boolean;
  tool: 'land' | 'biome' | 'pbrush';
  seed: number;
}

async function play(s: Scene, steps: number): Promise<string[]> {
  const w = s.world();
  world.value = w;
  tool.value = s.tool;
  picking.value = false;
  openPanel.value = null;
  toast.value = null;
  const r = makeRig(w, (log) => recorderTool(log, s.drags, { moveKey: !s.drags }), s.camera(), [W, H]);
  const rand = rng(s.seed);
  // 假的时钟：一串滚动算不算“连续”看的是它
  let now = 1000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  let x = W / 2;
  let y = H / 2;
  let held = -1;
  let shift = false;
  let alt = false;
  let space = false;
  const out: string[] = [];
  const ev = (button = 0) => ({ pointerType: 'mouse', pointerId: 1, isPrimary: true, button, buttons: held < 0 ? 0 : [1, 4, 2][held], clientX: x, clientY: y, shiftKey: shift, altKey: alt, pressure: held < 0 ? 0 : 0.5, width: 1, height: 1 });
  const note = (what: string) => {
    const calls = r.log.splice(0);
    const t = (toast.value as { text: string } | null)?.text ?? null;
    toast.value = null;
    out.push(`${what} | ${calls.join(' ; ') || '-'} | cam ${r.camera()} | pressed ${r.view.pressed ? 1 : 0} moved ${r.view.userMoved ? 1 : 0} ptr ${r.view.pointer ? 1 : 0} hover ${hoverCell.value} pin ${pinnedCell.value}${pinnedPart.value ?? ''} pick ${picking.value ? 1 : 0} panel ${openPanel.value ?? '-'} draws ${r.draws()}${t ? ` toast ${t}` : ''}`);
  };
  for (let k = 0; k < steps; k++) {
    now += 1 + Math.floor(rand() * 40);
    const roll = rand();
    if (roll < 0.5) {
      // 移动：多半是小步，有时跳得远、有时出了地图
      const big = rand() < 0.15;
      x = Math.round((x + (rand() - 0.5) * (big ? 500 : 14)) * 10) / 10;
      y = Math.round((y + (rand() - 0.5) * (big ? 400 : 14)) * 10) / 10;
      x = Math.max(-20, Math.min(W + 20, x));
      y = Math.max(-20, Math.min(H + 20, y));
      await r.fire('pointermove', ev());
      note(`move ${x},${y}`);
    } else if (roll < 0.64) {
      if (held < 0) {
        const b = rand();
        held = b < 0.6 ? 0 : b < 0.8 ? 2 : 1;
        await r.fire('pointerdown', ev(held));
        note(`down b${held}`);
      } else {
        const b = held;
        held = -1;
        await r.fire('pointerup', ev(b));
        note(`up b${b}`);
      }
    } else if (roll < 0.72) {
      // 点一下不动：按下马上松开
      if (held < 0) {
        const b = rand() < 0.7 ? 0 : 2;
        held = b;
        await r.fire('pointerdown', ev(b));
        held = -1;
        await r.fire('pointerup', ev(b));
        note(`tap b${b}`);
      }
    } else if (roll < 0.82) {
      const kind = rand();
      // 滚轮：鼠标的一格一格、触控板细碎带横向的、捏合（ctrl）
      const e = kind < 0.4 ? { deltaX: 0, deltaY: NOTCH * (rand() < 0.5 ? 1 : -1) * (1 + Math.floor(rand() * 3)), ctrlKey: false } : kind < 0.75 ? { deltaX: Math.round((rand() - 0.5) * 30), deltaY: Math.round((rand() - 0.5) * 30) + 0.5, ctrlKey: false } : { deltaX: 0, deltaY: (rand() - 0.5) * 20, ctrlKey: true };
      // 有时隔得久：下一串重新判断是滚轮还是触控板
      if (rand() < 0.4) now += 400;
      await r.fire('wheel', { ...e, deltaMode: 0, clientX: x, clientY: y });
      note(`wheel ${e.ctrlKey ? 'pinch' : e.deltaX ? 'pad' : 'notch'}`);
    } else if (roll < 0.86) {
      space = !space;
      r.key(space ? 'keydown' : 'keyup', 'Space');
      note(`space ${space ? 1 : 0}`);
    } else if (roll < 0.9) {
      shift = !shift;
      note(`shift ${shift ? 1 : 0}`);
    } else if (roll < 0.93) {
      alt = !alt;
      note(`alt ${alt ? 1 : 0}`);
    } else if (roll < 0.95) {
      await r.fire('pointerleave', ev());
      note('leave');
    } else if (roll < 0.97) {
      // Esc 走的那一条
      const used = r.input.cancel();
      note(`cancel ${used ? 1 : 0}`);
    } else if (roll < 0.98) {
      r.input.zoomAt(W / 2, H / 2, rand() < 0.5 ? 1.25 : 0.8);
      note('zoomBy');
    } else if (roll < 0.99) {
      picking.value = !picking.value;
      note(`picking ${picking.value ? 1 : 0}`);
    } else {
      openPanel.value = openPanel.value ? null : 'layers';
      note('panel');
    }
  }
  if (space) r.key('keyup', 'Space');
  r.input.dispose();
  clock.mockRestore();
  pinnedCell.value = -1;
  pinnedPart.value = null;
  return out;
}

describe('鼠标在地图上的行为（第一百轮前后逐条相同）', () => {
  it('一串鼠标事件调到工具上的、镜头、钉住的格与录下的相同', async () => {
    const region = continents({ provinces: true });
    const globe = smallGlobe();
    const plane = () => region.world;
    const sphere = () => globe.world;
    const scenes: Scene[] = [
      { name: '一块地区 · 拖的工具', world: plane, camera: () => ({ x: 0.5, y: 0.3, zoom: 900 }), drags: true, tool: 'land', seed: 11 },
      { name: '一块地区 · 点的工具（能吸取）', world: plane, camera: () => ({ x: 0.5, y: 0.3, zoom: 1400 }), drags: false, tool: 'biome', seed: 12 },
      { name: '一块地区 · 省份（按画出来的省吸取）', world: plane, camera: () => ({ x: 0.4, y: 0.3, zoom: 2000 }), drags: true, tool: 'pbrush', seed: 13 },
      { name: '整个星球 · 等距圆柱 · 拖的工具', world: sphere, camera: () => ({ x: 1, y: 0.5, zoom: 350 }), drags: true, tool: 'land', seed: 14 },
      { name: '整个星球 · 球形 · 点的工具', world: sphere, camera: () => ({ x: 1, y: 0.5, zoom: 500, proj: { kind: 'globe', lon0: 0.3, lat0: 0.2 } }), drags: false, tool: 'biome', seed: 15 },
      { name: '整个星球 · 球形 · 拖的工具', world: sphere, camera: () => ({ x: 1, y: 0.5, zoom: 700, proj: { kind: 'globe', lon0: -1.2, lat0: -0.4 } }), drags: true, tool: 'land', seed: 16 },
      { name: '整个星球 · 等面积 · 点的工具', world: sphere, camera: () => ({ x: 0, y: 0, zoom: 260, proj: { kind: 'equalEarth', lon0: 0.5, lat0: 0 } }), drags: false, tool: 'land', seed: 17 },
    ];
    const all: Record<string, string[]> = {};
    for (const s of scenes) all[s.name] = await play(s, 260);
    await expect(JSON.stringify(all, null, 1)).toMatchFileSnapshot('../__snapshots__/input-mouse.json');
  }, 120_000);
});
