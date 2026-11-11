import { useEffect, useRef } from 'preact/hooks';

// Esc 一层层退出（第六十九轮）：每一层自己登记“我开着时 Esc 做什么”，keys.ts 只问最上面的一层。
// 一层是一个函数：开着、用掉了这一下就做完并返回 true，没开着返回 false（往下一层问）。
// 先后只由 ESC_RANK 定（数大的在上），与谁先登记无关；同一个数时后登记的在上。
//
// 两个阶段：
//   capture  window 上捕获阶段先问（比输入框、面板里自己的键盘先收到）；用掉了就不再往下传（stopPropagation）
//   bubble   keys.ts 的 onKeyDown（冒泡到 window，输入框、面板自己处理过、没拦下的才到这里）
//
// 一直在的状态（信号）用 pushEscape 在它所在的模块里登记一次；组件里的（开着才有的小窗口）用 useEscape，挂着时才在栈里。

export type EscapeRun = (e: KeyboardEvent) => boolean;
export type EscapePhase = 'capture' | 'bubble';

// 先后（数大的先问）。改这里就是改 Esc 的顺序：escape-order.test.ts 一条条写着
export const ESC_RANK = {
  // ---- 捕获阶段 ----
  // 问一句的对话框（Ask.tsx）
  ask: 330,
  // 资源库里正在拖的卡片（page-drag.ts）
  drag: 320,
  // 脚本框的“变量和例子”（ScriptBox.tsx）：只关它，不关抽屉
  scriptHelp: 310,
  // ---- 冒泡阶段（以前 keys.ts 里的 if/else 链，从上到下） ----
  packDialog: 160,
  // 留着的旧世界（第九十一轮，maps/backups.ts）
  backupsDialog: 155,
  mapsDialog: 150,
  help: 140,
  // 星球形态编辑器：正在框里写时先离开框，再按一次关上
  formEditor: 130,
  // 向导：没有世界时关不上（这一下也不往下传）
  wizard: 120,
  openPanel: 110,
  // 资源库面板里开着的下拉（标题的来源下拉、右上角的“⋯”，第九十三轮）：先关它。以前这一下落到“资源库”那一层，把整个面板关了
  libMenu: 105,
  // 正在框里写：离开框
  input: 100,
  // 地图上正在画的一笔
  mapCancel: 90,
  // 工具自己的（不截走别的河）
  mapEscape: 80,
  // 量距离：先清空再退出
  measure: 70,
  picking: 60,
  uiHidden: 50,
  // 资源库：先收起右栏，再一层层返回，首页再按一次关上
  library: 40,
  sheet: 30,
  provinceSet: 20,
  // 选中的省份 / 地名 / 河 / 湖
  selection: 10,
} as const;

interface Layer {
  rank: number;
  phase: EscapePhase;
  run: EscapeRun;
  seq: number;
}

let layers: Layer[] = [];
let seq = 0;

// 登记一层；返回去掉它的函数
export function pushEscape(rank: number, run: EscapeRun, phase: EscapePhase = 'bubble'): () => void {
  const layer: Layer = { rank, phase, run, seq: ++seq };
  layers = [...layers, layer].sort((a, b) => b.rank - a.rank || b.seq - a.seq);
  return () => {
    layers = layers.filter((l) => l !== layer);
  };
}

// 从最上面的一层问起，有一层用掉了就停。返回有没有用掉
export function runEscape(e: KeyboardEvent, phase: EscapePhase): boolean {
  for (const l of layers) if (l.phase === phase && l.run(e)) return true;
  return false;
}

// 组件挂着（并且 on）时在栈里；run 每次取最新的（不因重画而重新登记）
export function useEscape(run: EscapeRun, rank: number, opts: { phase?: EscapePhase; on?: boolean } = {}) {
  const ref = useRef(run);
  ref.current = run;
  const on = opts.on ?? true;
  const phase = opts.phase ?? 'bubble';
  useEffect(() => (on ? pushEscape(rank, (e) => ref.current(e), phase) : undefined), [on, rank, phase]);
}

// 焦点在输入框里（Esc 先离开框）
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
}

// 捕获阶段：App 挂在 window 上（第三个参数 true）
export function onEscapeCapture(e: KeyboardEvent) {
  if (e.key === 'Escape' && runEscape(e, 'capture')) e.stopPropagation();
}
