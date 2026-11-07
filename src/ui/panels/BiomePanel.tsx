import { openPanel, options, world } from '../../state';
import { openBiomeEditor } from '../ecology/open';
import { paintWith } from '../defs/tools';

// 生态类型的色板（第十四轮：顶栏的“生态”按钮去掉了，色板挪进“自然”）：
// 只在“自然 ⋯”里（涂生态底部条上点当前的生态也是打开它）。选一种就换到“涂生态”。
// 编辑生态类型在资源库的面板里（第七十二轮：生态与水系 → 生态 → 这一种，以前是右边的抽屉），可以一边调一边看地图

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
            <span class="swatch" style={{ background: s.color }} />
            {s.name || s.id}
          </button>
        ))}
      </div>
      <p class="hint">选一种换到“涂生态”；Alt+点吸取</p>
      <div class="row wrap">
        <button
          onClick={() => {
            openBiomeEditor(options.value.biome);
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
