import { RefreshCw } from 'lucide-preact';
import { exec, regenTrack, world } from '../../state';
import { REGEN_BUSY, regenCountText } from './copy';
import type { PageCtx } from './page-source';
import { regenCommand, regenNeed } from './regen';

// 面板底下的“改了 N 项 · 重新生成”（第六十二轮在顶上，第八十一轮挪到底下，省份划分也算）：只在看本世界、内容改了地图还没用上时出现。
// 算不算要重新生成在 regen.ts，看的是整个世界，就地展开改的项也算。写清楚会重做什么、手改过的会不会被换掉；一步，能撤销
export function RegenBar({ ctx }: { ctx: PageCtx }) {
  const w = ctx.world;
  if (!w) return null;
  const need = regenNeed(w.small, regenTrack.base(), ctx.lib);
  if (!need) return null;
  return (
    <div class="lp-regen">
      <span class="grow lp-regen-text">
        <b>{regenCountText(need.count)}</b>
        <span class="hint">{need.what}</span>
        {need.warn && <span class="hint warn">{need.warn}</span>}
      </span>
      <button
        class="small primary"
        onClick={() => {
          const now = world.value;
          if (now) void exec(regenCommand(need, now.small, ctx.lib), REGEN_BUSY);
        }}
      >
        <RefreshCw /> 重新生成
      </button>
    </div>
  );
}
