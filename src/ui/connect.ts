import { findScripts } from '../../core/script';
import { safeMode, scriptEditor, setSpeciesVisualOverride, world, worldEpoch } from '../state';
import { forgetDrafts, trustDraft } from '../trust';
import { type CommittedScript, openScriptEditor, registerScriptCommitted, registerVisualOverride } from './editor-hooks';

// 第三批几处各自做好的口子在这里接上（main.tsx 一开始引用一次）：
// - 生态编辑器拖花纹、发光滑块：画面那边在主线程上临时换掉这种生态的外观，地图立即重画（state.ts 的 visualOverrides）；
// - 脚本框提交的脚本：记进信任列表（trust.ts），同一步里被换掉的中间版本去掉；
// - 顶部“「X」的脚本出错了”的“编辑”：打开生态抽屉、展开“高级”、光标放进那个脚本框
//   （河流类型的规则由 state.ts 的 editScript 打开“水系 ⋯”里那种河，星球形态的脚本没有“编辑”）

registerVisualOverride(setSpeciesVisualOverride);

// 世界上（各种生态、河流类型、在用的星球形态里）还用着这一段
function usedInWorld(src: string): boolean {
  const w = world.value;
  return !!w && findScripts([w.small.species, w.small.riverTypes ?? [], w.small.terrain?.gen?.form ?? []]).some((s) => s.src === src);
}

let draftEpoch = -1;
export function scriptCommitted(c: CommittedScript): Promise<void> {
  // 安全模式下不记（与 state.ts 的 trustOwn 一样：那里的脚本可能是从没信任的世界里复制来的）
  if (safeMode.value) return Promise.resolve();
  const epoch = worldEpoch.value;
  if (epoch !== draftEpoch) {
    forgetDrafts();
    draftEpoch = epoch;
  }
  return trustDraft({ slot: `${epoch}:${c.species}:${c.kind}`, src: c.src, before: c.before, mode: c.mode, inUse: usedInWorld });
}
registerScriptCommitted((c) => void scriptCommitted(c));

scriptEditor.open = openScriptEditor;
