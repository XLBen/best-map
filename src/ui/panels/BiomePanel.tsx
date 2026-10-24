import { speciesColor } from '../../../core/species';
import { focusSpecies, openPanel, options, sheet, world } from '../../state';
import { paintWith } from '../defs/tools';

// 生态类型的色板（第十四轮：顶栏的“生态”按钮去掉了，色板挪进“自然”）：
// 只在“自然 ⋯”里（涂生态底部条上点当前的生态也是打开它）。选一种就换到“涂生态”。
// 编辑生态类型在右边的抽屉里，可以一边调一边看地图

export function BiomePalette() {
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
      <p class="hint">选一种换到“涂生态”；Alt+点吸取</p>
      <div class="row wrap">
        <button
          onClick={() => {
            focusSpecies.value = options.value.biome;
            sheet.value = 'species';
            openPanel.value = null;
          }}
        >
          编辑生态类型…
        </button>
        <span class="hint">颜色、名字、冷暖干湿，或新建一种</span>
      </div>
    </>
  );
}
