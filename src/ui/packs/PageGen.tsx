import { ChevronRight } from 'lucide-preact';
import { FieldsBox } from './ContentEditor';
import { GEN_NO_ERA, GEN_REGEN_NOTE, GEN_TIERS_NOTE, genMore } from './copy';
import { WeightTable } from './editors';
import type { Obj } from './fields';
import { type GenNotes, type GenTarget, genCommand, genNotes, genPage } from './gen-settings';
import { queueWorld } from './page-actions';
import type { PageCtx } from './page-source';
import { openRoute } from './panel-store';

// 生成设置（第八十一轮）：本世界最常调的几项，改的是本世界的时代、省份划分（和它们自己的页面同一条命令，gen-settings.ts）。
// 改了要重新生成时面板底下出现“改了 N 项 · 重新生成”，和别处一样。
// 第九十三轮：每一项下面一句现在是什么样（几个国家、一共多少人，gen-settings.ts 的 genNotes）；别的在各自页面的“更多设置”里

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
  const notes = era && ctx.world ? genNotes(ctx.world, era.item) : null;
  return (
    <div class="lp-item lp-gen">
      <h5>国家与人口</h5>
      {era && eraObj ? (
        <>
          <p class="hint">{GEN_REGEN_NOTE}</p>
          {era.fields.map((f) => (
            <div class="lp-gen-field" key={f.key}>
              <FieldsBox fields={[{ ...f, hint: undefined }]} scope={era.kind.fields} value={eraObj} issues={[]} onChange={(next) => save(era, next, f.label)} />
              <p class="hint ed-hint">{notes?.[f.key as keyof GenNotes] ?? f.hint}</p>
            </div>
          ))}
          {p.tiers && (
            <div class="ed-group">
              <div class="ed-label">{p.tiers.label}</div>
              <WeightTable f={p.tiers} value={eraObj.tiers} onChange={(v) => save(era, { ...eraObj, tiers: v }, p.tiers!.label)} />
              <p class="hint ed-hint">{GEN_TIERS_NOTE}</p>
            </div>
          )}
          <More t={era as GenTarget<unknown>} label={genMore(`时代“${era.item.name}”`)} />
        </>
      ) : (
        <p class="hint">{GEN_NO_ERA}</p>
      )}
      <h5>省份</h5>
      {prov ? (
        <>
          <FieldsBox fields={prov.fields} scope={prov.kind.fields} value={prov.item as unknown as Obj} issues={[]} onChange={(next) => save(prov, next, '省份大小')} />
          <More t={prov as GenTarget<unknown>} label={genMore('省份划分')} />
        </>
      ) : (
        <p class="hint">这张地图没有省份划分，按默认的划</p>
      )}
    </div>
  );
}
