import { speciesColor } from '../../../core/species';
import { focusSpecies, openPanel, options, sheet, world } from '../../state';
import { paintWith } from '../defs/tools';

// “生态”：要涂的生态（色板）；编辑生态类型在右边的抽屉里，可以一边调一边看地图

export function BiomePanel() {
  const w = world.value;
  if (!w) return null;
  return (
    <>
      <div class="palette">
        {w.small.species.map((s) => (
          <button
            class={`chip ${options.value.biome === s.id ? 'on' : ''}`}
            onClick={() => {
              paintWith(s.id);
              openPanel.value = null;
            }}
          >
            <span class="swatch" style={{ background: speciesColor(s) }} />
            {s.name || s.id}
          </button>
        ))}
      </div>
      <p class="muted small">选一种就换到“涂生态”。也可以在地图上按住 Alt 点一下，吸取那里的生态。</p>
      <button
        onClick={() => {
          focusSpecies.value = options.value.biome;
          sheet.value = 'species';
          openPanel.value = null;
        }}
      >
        编辑生态类型…
      </button>
      <span class="muted small"> 改颜色、名字、喜欢的冷暖干湿，或新建一种</span>
    </>
  );
}
