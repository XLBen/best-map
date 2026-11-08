import { ChevronRight } from 'lucide-preact';
import { FieldsBox } from './ContentEditor';
import { GEN_NO_ERA, GEN_POP_NOTE } from './copy';
import { WeightTable } from './editors';
import type { Obj } from './fields';
import { type GenTarget, genCommand, genPage } from './gen-settings';
import { queueWorld } from './page-actions';
import type { PageCtx } from './page-source';
import { openRoute } from './panel-store';

// 生成设置（第八十一轮）：本世界最常调的几项，改的是本世界的时代、省份划分（和它们自己的页面同一条命令，gen-settings.ts）。
// 改了要重新生成时面板底下出现“改了 N 项 · 重新生成”，和别处一样

function save<T>(t: GenTarget<T>, next: Obj, what: string) {
  void queueWorld((w) => genCommand(t, next, w, what));
}

function More({ t, label }: { t: GenTarget<unknown>; label: string }) {
  return (
    <button class="lp-related" onClick={() => openRoute(t.route)}>
      <span class="grow">{label}</span>
      <ChevronRight />
    </button>
  );
}

export function PageGen({ ctx }: { ctx: PageCtx }) {
  const p = genPage(ctx);
  if (!p) return null;
  const era = p.era;
  const prov = p.provinces;
  const eraObj = era?.item as unknown as Obj | undefined;
  return (
    <div class="lp-item lp-gen">
      <h5>国家与人口</h5>
      {era && eraObj ? (
        <>
          <FieldsBox
            fields={era.fields}
            scope={era.kind.fields}
            value={eraObj}
            issues={[]}
            onChange={(next) => {
              const f = era.fields.find((x) => next[x.key] !== eraObj[x.key]);
              save(era, next, f?.label ?? '时代');
            }}
          />
          <p class="hint">{GEN_POP_NOTE}</p>
          {p.tiers && (
            <div class="ed-group">
              <div class="ed-label">{p.tiers.label}</div>
              <WeightTable f={p.tiers} value={eraObj.tiers} onChange={(v) => save(era, { ...eraObj, tiers: v }, p.tiers!.label)} />
            </div>
          )}
          <More t={era as GenTarget<unknown>} label={`时代“${era.item.name}”的其余几项`} />
        </>
      ) : (
        <p class="hint">{GEN_NO_ERA}</p>
      )}
      <h5>省份</h5>
      {prov ? (
        <>
          <FieldsBox fields={prov.fields} scope={prov.kind.fields} value={prov.item as unknown as Obj} issues={[]} onChange={(next) => save(prov, next, '省份大小')} />
          <More t={prov as GenTarget<unknown>} label="省份划分的其余几项" />
        </>
      ) : (
        <p class="hint">本世界没有省份划分，按默认的划</p>
      )}
    </div>
  );
}
