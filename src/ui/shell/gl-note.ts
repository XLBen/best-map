import type { GlState } from '../../render/gl-recover';
import { GL_TEXT as T } from '../copy';

// 地图的画面出了事时盖在地图上的那一层写什么（第九十六轮；纯函数，测试直接调）。
// 正在恢复时只说一句、转圈；恢复不了、画不出来时说清楚世界存好了没有、现在点什么
export interface GlNote {
  text: string;
  // 转圈（正在恢复）
  busy: boolean;
  actions: ('reload' | 'export')[];
}

export function glNote(state: GlState, unsaved: boolean): GlNote | null {
  if (state === 'ok') return null;
  if (state === 'lost') return { text: T.lost, busy: true, actions: [] };
  const head = state === 'stuck' ? T.stuck : T.broken;
  // 有没存好的改动：先导出文件（重新载入时浏览器也会问）；都存好了：直接重新载入
  return unsaved ? { text: `${head}${T.unsaved}`, busy: false, actions: ['export', 'reload'] } : { text: `${head}${T.saved}`, busy: false, actions: ['reload'] };
}
