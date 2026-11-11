import { LocateFixed } from 'lucide-preact';
import { useMemo } from 'preact/hooks';
import type { ContentKind } from '../../../core/content/registry';
import { openPanel, world } from '../../state';
import { execRegen } from '../domain/regen-ask';
import { focusOn } from '../camera';
import { ON_MAP, ON_MAP_UNUSED, REGEN_BUSY } from './copy';
import { type OnMapFix, onMapOf } from './on-map';
import type { PageCtx } from './page-source';
import { openRoute } from './panel-store';
import { regenCommand } from './regen';
import { regenNow } from './regen-now';
import { runTrusted } from './row-actions';

// 一项顶上的“在地图上”一行（第九十轮，只在看本世界时）：用在多少格、多少国家、多少城市，能定位；
// 没用上时写原因，旁边一个按钮一下子解决（规则在 on-map.ts）。改了要重新生成的写“重新生成后才出现”，按钮就是面板底下的那一步
export function OnMapLine({ kind, id, item, ctx, onSegment }: { kind: ContentKind; id: string; item: unknown; ctx: PageCtx; onSegment: (seg: string) => void }) {
  const w = ctx.world;
  const need = w ? regenNow(w.small, ctx.lib) : null;
  const m = useMemo(() => onMapOf(kind, id, item, ctx, need), [kind, id, item, ctx.world, ctx.lib, need]);
  if (!m) return null;
  const run = (fix: OnMapFix) => {
    switch (fix.t) {
      case 'command':
        return void runTrusted(fix.cmd, fix.busy);
      case 'regen': {
        const now = world.value;
        if (now && need) void execRegen(regenCommand(need, now.small, ctx.lib), REGEN_BUSY);
        return;
      }
      case 'segment':
        return onSegment(fix.seg);
      case 'route':
        return openRoute(fix.route);
      case 'panel':
        openPanel.value = fix.panel;
        return;
    }
  };
  return (
    <div class={`lp-onmap ${m.used ? '' : 'off'}`}>
      <span class="hint lp-onmap-label">{ON_MAP}</span>
      <span class="grow lp-onmap-text">{m.used ? m.text : `${ON_MAP_UNUSED}：${m.text}`}</span>
      {m.cells && (
        <button class="small" onClick={() => focusOn(m.cells!)}>
          <LocateFixed /> 定位
        </button>
      )}
      {m.fix && (
        <button class="small primary" onClick={() => run(m.fix!)}>
          {m.fix.label}
        </button>
      )}
    </div>
  );
}
