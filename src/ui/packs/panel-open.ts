import { kindOf } from '../../../core/content/registry';
import { newItemIn } from './page-actions';
import { goTo, libPanel, livePanel, openLibrary, pageCtx } from './panel-store';

// 从别处打开资源库面板，同时新建一项（底部条上的“新类型…”）：在本世界里新建，到它的页面
export { openLibrary };
export async function openNewItemIn(kindId: string): Promise<void> {
  openLibrary({ kind: kindId });
  const kind = kindOf(kindId);
  const st = libPanel.value;
  if (!kind || !st) return;
  const ctx = pageCtx();
  const r = await newItemIn(livePanel(st, ctx).source, kind, ctx);
  if (r && libPanel.value) goTo(r);
}
