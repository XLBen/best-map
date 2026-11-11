import type { WaterType } from '../../../core/water-types';
import { world, worldEpoch } from '../../state';
import { showCell } from '../editor-hooks';
import { KINDS, type WaterKind, applyMatch, matchIssue, settleTypeEdits, typeEditsSettled } from '../panels/water-types';
import { ScriptBox } from '../ScriptBox';

// 河、湖的“规则”一段在这张地图里（第九十三轮）：和以前“水系 ⋯”里“水体类型”的编辑器同一个脚本框——停一下就用到地图上，
// 出错写在框下面，能点过去看是哪一格（逻辑在 panels/water-types.ts）。我的库里照旧是普通的框（那里没有地图可以试）
export function WaterScript({ kind, t }: { kind: WaterKind; t: WaterType }) {
  const w = world.value;
  const def = KINDS[kind];
  if (!w) return null;
  return (
    <ScriptBox
      // 换了世界、换了类型都是新的框（还没提交的不会落到别处）
      key={`${worldEpoch.value}:${kind}:${t.id}:match`}
      kind="match"
      scope={kind}
      label={def.matchLabel}
      hint={def.matchHint}
      value={t.scripts?.match?.src ?? ''}
      issue={() => matchIssue(t.id, t.name)}
      apply={(src, mode, revert) => applyMatch(kind, t.id, src, mode, revert)}
      idle={typeEditsSettled}
      settle={settleTypeEdits}
      fields={Object.keys(w.causes.fields)}
      onShowCell={showCell}
    />
  );
}
