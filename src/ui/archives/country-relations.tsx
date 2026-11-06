import { X } from 'lucide-preact';
import { BLOC_NAMES, blocsOf } from '../../../core/human';
import type { CountryMeta, World } from '../../../core/world';
import { countriesByName, vassalsOf, withId, withoutId } from '../domain/countries';
import { BLOC_KIND_OPTIONS, SUBJECT_OPTIONS, joinBlocCommand, joinNote, joinableBlocs, leaveBlocCommand, newBlocCommand, selectBloc, subjectCommand } from '../domain/blocs';
import { showCountry } from '../panels/countries';
import { patch, run } from '../country-archive';
import { Line } from './fields';

// 国家档案的“关系”一页（第七十轮从 CountryArchive.tsx 按页分出来）

// 外交里一组国家（同盟、敌对）：一个个小块（点了选中那一国），× 去掉，最后一个下拉框加一国
function CountryChips({ w, ids, others, onChange, label }: { w: World; ids: number[]; others: CountryMeta[]; onChange: (ids: number[]) => void; label: string }) {
  const metas = w.small.countries ?? {};
  const free = others.filter((x) => !ids.includes(x.id));
  return (
    <Line label={label}>
      <span class="chips grow">
        {ids.map((id) =>
          metas[id] ? (
            <span class="chip static">
              <span class="swatch" style={{ background: metas[id].color }} />
              <button class="link" onClick={() => showCountry(w, id)}>
                {metas[id].name}
              </button>
              <button class="icon-btn" onClick={() => onChange(withoutId(ids, id))} title="去掉">
                <X />
              </button>
            </span>
          ) : null,
        )}
        {!ids.length && <span class="hint">无</span>}
        {free.length > 0 && (
          <select
            class="chip-add"
            value=""
            onChange={(e) => {
              const v = Number((e.target as HTMLSelectElement).value);
              if (v) onChange(withId(ids, v));
            }}
          >
            <option value="">加一国</option>
            {free.map((x) => (
              <option value={x.id}>{x.name}</option>
            ))}
          </select>
        )}
      </span>
    </Line>
  );
}

// 所在的帝国、联邦、同盟：点名字打开集团的档案，× 退出；下拉框加入一个，或以这一国为盟主新建
function BlocLine({ w, m }: { w: World; m: CountryMeta }) {
  const mine = blocsOf(w, m.id);
  const free = joinableBlocs(w, m.id);
  return (
    <Line label="集团">
      <span class="chips grow">
        {mine.map((b) => (
          <span class="chip static">
            <span class="swatch" style={{ background: b.color }} />
            <button class="link" onClick={() => selectBloc(b.id)} title={BLOC_NAMES[b.kind]}>
              {b.name}
            </button>
            <button class="icon-btn" onClick={() => void run(leaveBlocCommand(b, m.id))} title="退出">
              <X />
            </button>
          </span>
        ))}
        {!mine.length && <span class="hint">无</span>}
        <select
          class="chip-add"
          value=""
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            const [op, x] = v.split(':');
            const b = op === 'join' ? free.find((y) => y.id === Number(x)) : undefined;
            if (b) void run(joinBlocCommand(b, m.id));
            else if (op === 'new') void run(newBlocCommand(x as (typeof BLOC_KIND_OPTIONS)[number][0], m.id));
          }}
        >
          <option value="">{free.length ? '加入、新建' : '新建'}</option>
          {free.length > 0 && (
            <optgroup label="加入">
              {free.map((b) => (
                <option value={`join:${b.id}`} title={joinNote(w, b, m.id)}>
                  {b.name}（{BLOC_NAMES[b.kind]}）
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="新建">
            {BLOC_KIND_OPTIONS.map(([k, label]) => (
              <option value={`new:${k}`}>{label}</option>
            ))}
          </optgroup>
        </select>
      </span>
    </Line>
  );
}

export function DiplomacySection({ w, m }: { w: World; m: CountryMeta }) {
  const metas = w.small.countries ?? {};
  const others = countriesByName(w).filter((x) => x.id !== m.id);
  // 宗主不能是自己的附庸（一层层往下）
  const below = new Set<number>();
  const walk = (id: number) => {
    for (const v of vassalsOf(w, id)) if (!below.has(v.id)) (below.add(v.id), walk(v.id));
  };
  walk(m.id);
  const vassals = vassalsOf(w, m.id);
  const overlord = m.overlord !== undefined ? metas[m.overlord] : undefined;
  return (
    <section>
      <h5>外交</h5>
      <Line label="宗主">
        {overlord && <span class="swatch" style={{ background: overlord.color }} />}
        <select class="grow" value={m.overlord ?? ''} onChange={(e) => void patch(m.id, { overlord: Number((e.target as HTMLSelectElement).value) || null })}>
          <option value="">无</option>
          {others
            .filter((x) => !below.has(x.id))
            .map((x) => (
              <option value={x.id}>{x.name}</option>
            ))}
        </select>
      </Line>
      <Line label="从属">
        <select
          class="grow"
          value={m.subject ?? 'vassal'}
          disabled={!overlord}
          title={overlord ? undefined : '先选宗主'}
          onChange={(e) => void run(subjectCommand(m, (e.target as HTMLSelectElement).value as (typeof SUBJECT_OPTIONS)[number][0]))}
        >
          {SUBJECT_OPTIONS.map(([k, label]) => (
            <option value={k}>{label}</option>
          ))}
        </select>
      </Line>
      <Line label="附庸">
        <span class="chips grow">
          {vassals.map((v) => (
            <span class="chip static">
              <span class="swatch" style={{ background: v.color }} />
              <button class="link" onClick={() => showCountry(w, v.id)}>
                {v.name}
              </button>
            </span>
          ))}
          {!vassals.length && <span class="hint">无</span>}
        </span>
      </Line>
      <BlocLine w={w} m={m} />
      <CountryChips w={w} label="同盟" ids={m.allies} others={others.filter((x) => !m.rivals.includes(x.id))} onChange={(allies) => void patch(m.id, { allies })} />
      <CountryChips w={w} label="敌对" ids={m.rivals} others={others.filter((x) => !m.allies.includes(x.id))} onChange={(rivals) => void patch(m.id, { rivals })} />
    </section>
  );
}
