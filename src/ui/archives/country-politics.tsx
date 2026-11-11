import { categoryName, currentRuler, worldCultureGroups, worldCultures } from '../../../core/human';
import type { CountryMeta, World } from '../../../core/world';
import { library } from '../../library';
import { governmentChoices, governmentCommand, titlePreview } from '../domain/countries';
import { ARCHIVE_TEXT } from '../copy';
import { firstLine } from '../domain/human';
import { LibraryLink } from '../shell/TypePicker';
import { countryTab, patch, run } from '../country-archive';
import { Line } from './fields';

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
              title={`${g.description ?? ''}${!m.nameLocked && !on ? `\n国名改为“${next}”` : ''}${c.path ? '\n这张地图还没有：选它时从资源库添加' : ''}`}
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

// 统治者（第八十五轮起是一份名单，在“历史”页）：这里只写现在的那一位，点了去“历史”
export function RulerSection({ w, m }: { w: World; m: CountryMeta }) {
  const r = currentRuler(w.small, m.id);
  return (
    <section>
      <h5>{ARCHIVE_TEXT.rulers}</h5>
      <Line label={ARCHIVE_TEXT.current}>
        <button class="link grow ellipsis" onClick={() => (countryTab.value = 'history')} title={ARCHIVE_TEXT.rulersHint}>
          {r ? `${r.title ?? ''}${r.name}` : '—'}
        </button>
      </Line>
    </section>
  );
}
