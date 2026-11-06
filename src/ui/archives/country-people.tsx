import { countryFaith, FAITH_NAMES } from '../../../core/human';
import type { CountryMeta, World } from '../../../core/world';
import { statsOf } from '../domain/countries';
import { densityText, popText, shareText } from '../domain/human';
import { StackBar } from '../CountryFactions';
import { CityList } from '../panels/settlements';
import { countryCityRows, hasAnySettle } from '../domain/settlements';
import { selectSettle } from '../tools/settlements';
import { Line, ShareRow } from './fields';

// 国家档案的“人口与城市”一页（第七十轮从 CountryArchive.tsx 按页分出来）

export function StatsSection({ w, m }: { w: World; m: CountryMeta }) {
  const st = statsOf(w).get(m.id);
  if (!st) return null;
  const top = st.cultures.slice(0, 5);
  const other = Math.max(0, 1 - top.reduce((a, x) => a + x.share, 0));
  // 第四十三轮：国教，与信异端（同组不同派）、异教（不同组）的人
  const faith = countryFaith(w, m.id, st);
  return (
    <section>
      <h5>统计</h5>
      <div class="stat-grid">
        <span class="hint">人口</span>
        <b>{popText(st.population)}</b>
        <span class="hint">面积</span>
        <b>{Math.round(st.areaKm2).toLocaleString()} km²</b>
        <span class="hint">密度</span>
        <b>{densityText(st.density)}</b>
        <span class="hint">省份</span>
        <b>{st.provinces} 个</b>
      </div>
      {st.population > 0 && (
        <>
          <p class="hint">文化</p>
          <StackBar items={st.cultures} />
          {top.map((c) => (
            <ShareRow color={c.color} label={c.name} share={c.share} title={`${popText(c.people)} 人`} />
          ))}
          {other > 0.005 && <ShareRow color="var(--faint)" label="其他" share={other} />}
          {st.values.map((v) =>
            v.items.length ? (
              <>
                <p class="hint">{v.label}</p>
                <StackBar items={v.items} />
              </>
            ) : null,
          )}
          {faith && (
            <p class="hint">
              国教：{faith.name}
              {faith.group ? `（${faith.group}）` : ''}
              {faith.heretic > 0.005 ? ` · ${FAITH_NAMES.heretic} ${shareText(faith.heretic)}` : ''}
              {faith.heathen > 0.005 ? ` · ${FAITH_NAMES.heathen} ${shareText(faith.heathen)}` : ''}
            </p>
          )}
          {st.minorityShare > 0.005 && <p class="hint">不兼容的少数群体 {shareText(st.minorityShare)}</p>}
        </>
      )}
    </section>
  );
}

// 城市（第二十四轮）：首都、陪都，按人口排的城市（点一座打开它的档案）
export function CitySection({ w, m }: { w: World; m: CountryMeta }) {
  if (!hasAnySettle(w)) return null;
  const rows = countryCityRows(w, m.id);
  const caps = rows.filter((c) => c.capital || c.secondCapital).sort((a, b) => Number(b.capital) - Number(a.capital));
  return (
    <section>
      <h5>城市 · {rows.length} 座</h5>
      {caps.length > 0 && (
        <Line label="首都">
          <span class="chips grow">
            {caps.map((c) => (
              <button class="link" onClick={() => selectSettle({ kind: c.point ? 'point' : 'city', id: c.id })} title={c.capital ? '首都' : '陪都'}>
                {c.name}
                {c.capital ? '' : '（陪都）'}
              </button>
            ))}
          </span>
        </Line>
      )}
      <CityList cities={rows} limit={12} />
    </section>
  );
}
