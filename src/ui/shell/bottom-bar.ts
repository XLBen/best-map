import { createRef } from 'preact';

// 底部条（ContextBar.tsx）的元素：它挂上时自己填进来（ref），地图据此量要把左下角的比例尺抬多高（MapView.tsx 的 barLift）。
// 第六十九轮：以前地图在整个页面里找 .bottombar
export const bottomBarRef = createRef<HTMLDivElement>();
