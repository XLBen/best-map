import { RefreshCw } from 'lucide-preact';
import { exec, regenTrack, world } from '../../state';
import type { PageCtx } from './page-source';
import { regenCommand, regenNeed } from './regen';

// 面板顶上的“重新生成”（第六十二轮）：内容改了、地图还没用上时才出现。算不算要重新生成在 regen.ts，看的是整个世界，就地展开改的项也算。
// 按钮写清楚重算什么；一步，能撤销
export function RegenBar({ ctx }: { ctx: PageCtx }) {
  const w = ctx.world;
  if (!w) return null;
  const need = regenNeed(w.small, regenTrack.base(), ctx.lib);
  if (!need) return null;
  return (
    <div class="lp-regen">
      <span class="grow">
        <span class="hint">
          改了 {need.count} 项。{need.what}
        </span>
      </span>
      <button
        class="small primary"
        onClick={() => {
          const now = world.value;
          if (now) void exec(regenCommand(need, now.small, ctx.lib), '正在生成…');
        }}
      >
        <RefreshCw /> {need.label}
      </button>
    </div>
  );
}
