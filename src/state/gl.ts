import { signal } from '@preact/signals';
import type { GlState } from '../render/gl-recover';

// 地图的画面（WebGL）现在怎么样（第九十六轮）：ui/MapView.tsx 写，盖在地图上的那一层（ui/shell/GlNote.tsx）读。
// 规则在 ../render/gl-recover.ts
export const glState = signal<GlState>('ok');
// 坏了时的原话（“原因”里写）
export const glReason = signal('');
