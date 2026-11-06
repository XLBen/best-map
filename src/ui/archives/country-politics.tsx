import { categoryName, worldCultureGroups, worldCultures } from '../../../core/human';
import type { CountryMeta, World } from '../../../core/world';
import { library } from '../../library';
import { governmentChoices, governmentCommand, rulerPatch, titlePreview } from '../domain/countries';
import { firstLine } from '../domain/human';
import { LibraryLink } from '../shell/TypePicker';
import { patch, run } from '../country-archive';
import { Line, TextField } from './fields';

// 国家档案的“政治”一页（第七十轮从 CountryArchive.tsx 按页分出来；派系在 CountryFactions.tsx）

export function GovernmentSection({ w, m }: { w: World; m: CountryMeta }) {
  const lib = library.value;
  const list = governmentChoices(w, m.government, lib);
  return (
    <section>
      <h5>政体</h5>
      <div class="list gov-list">
        {list.map((c) => {
          const g = c.gov;
          const next = titlePreview(w, m, g);
          const on = g.id === m.government && !c.path;
          return (
            <button
              class={`item ${on ? 'on' : ''}`}
              title={`${g.description ?? ''}${!m.nameLocked && !on ? `\n国名改为“${next}”` : ''}${c.path ? '\n本世界还没有：选它时从资源库添加' : ''}`}
              onClick={() => void run(governmentCommand(w, m, c, lib))}
            >
              {g.color && <span class="swatch" style={{ background: g.color }} />}
              <span class="grow item-text">
                <span>{g.name}</span>
                <span class="hint ellipsis">{firstLine(g.description) || g.category.map(categoryName).join('、')}</span>
              </span>
              {!on && !m.nameLocked && <span class="hint ellipsis gov-title">{next}</span>}
            </button>
          );
        })}
      </div>
      <LibraryLink kind="government" title="资源库里别的政体（时代没写的也能用）" />
    </section>
  );
}

export function CultureSection({ w, m }: { w: World; m: CountryMeta }) {
  const groups = worldCultureGroups(w.small);
  const cultures = worldCultures(w.small);
  const primary = cultures.find((c) => c.id === m.primaryCulture);
  return (
    <section>
      <h5>文化</h5>
      <Line label="主流">
        {primary && <span class="swatch" style={{ background: primary.color }} />}
        <select class="grow" value={m.primaryCulture} onChange={(e) => void patch(m.id, { primaryCulture: (e.target as HTMLSelectElement).value })} title={m.nameLocked ? undefined : '没改过名字时国名按新文化的风格重起'}>
          {groups.map((g) => (
            <optgroup label={g.name}>
              {cultures
                .filter((c) => c.group === g.id)
                .map((c) => (
                  <option value={c.id}>{c.name}</option>
                ))}
            </optgroup>
          ))}
        </select>
      </Line>
      <LibraryLink kind="culture" />
      <p class="hint">兼容的文化组</p>
      <div class="check-grid">
        {groups.map((g) => {
          const on = m.acceptedGroups.includes(g.id);
          const fixed = g.id === primary?.group;
          return (
            <label class="check" title={fixed ? '主流文化的组总是兼容' : g.description}>
              <input
                type="checkbox"
                checked={on}
                disabled={fixed}
                onChange={() => void patch(m.id, { acceptedGroups: on ? m.acceptedGroups.filter((x) => x !== g.id) : [...m.acceptedGroups, g.id] })}
              />
              <span class="swatch" style={{ background: g.color }} />
              {g.name}
            </label>
          );
        })}
      </div>
    </section>
  );
}

export function RulerSection({ m }: { m: CountryMeta }) {
  const r = m.ruler;
  const set = (name: string, orig: string, title: string) => void patch(m.id, rulerPatch(m, name, orig, title));
  return (
    <section>
      <h5>统治者</h5>
      <Line label="称号">
        <TextField value={r.title ?? ''} maxLength={16} placeholder="国王、可汗……" onCommit={(v) => set(r.name, r.orig ?? '', v)} />
      </Line>
      <Line label="名字">
        <TextField value={r.name} onCommit={(v) => set(v, r.orig ?? '', r.title ?? '')} />
        <TextField class="arch-orig" value={r.orig ?? ''} maxLength={80} placeholder="原文" onCommit={(v) => set(r.name, v, r.title ?? '')} />
      </Line>
    </section>
  );
}
