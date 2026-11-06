import { Lock, LockOpen, ScanSearch } from 'lucide-preact';
import { askUser, nameMode, selectedCountry, sheet, world } from '../state';
import { focusOn } from './camera';
import { Toggle } from './components/Toggle';
import { cellsOf, tierLabel } from './domain/countries';
import { FactionSection, StackBar } from './CountryFactions';
import { Flag } from './panels/countries';
import { Seg } from './common';
import { COUNTRY_TABS, type CountryTab, countryTab, patch, run } from './country-archive';
import { ColorCapital, FlagSection, Glance, NameSection, TerritorySection } from './archives/country-overview';
import { CultureSection, GovernmentSection, RulerSection } from './archives/country-politics';
import { CitySection, StatsSection } from './archives/country-people';
import { DiplomacySection } from './archives/country-relations';
import { HistorySection } from './archives/country-history';
import { registerArchive } from './defs/archive-registry';

// 国家的档案（第二十三轮）：右边的抽屉，选中的国家。名字、旗帜、颜色、首都、政体、主流文化与兼容的文化组、统计、派系、外交、统治者、
// 建国年份、历史。改的都是 set_country 的 patch；字在离开框（或回车）时提交，历史停下一会儿也提交。
// 第二十六轮：头上写等级；外交里有从属的种类、所在的帝国、联邦、同盟（加入、退出、新建，见 domain/blocs.ts）。
// 第二十七轮：分成几页（概览 · 政治 · 人口与城市 · 关系 · 历史）；名字和原文一起改；领土的操作（涂领土、分成两半、并入别国、删除）放进概览


export { StackBar };

// 几样小部件：城市、集团的档案照旧从这里引用（第七十轮起写在 archives/fields.tsx）
export { Line, ShareRow, TextField } from './archives/fields';

// ---------- 抽屉 ----------

export function CountryArchive() {
  const w = world.value;
  const id = selectedCountry.value;
  const m = w && id !== null ? w.small.countries?.[id] : undefined;
  void nameMode.value;
  if (!w || !m) return <p class="hint">没有选中国家</p>;
  const remove = async () => {
    const v = await askUser({
      title: '删除国家',
      text: `“${m.name}”的领土成为无主地。可以撤销。`,
      choices: [
        { value: 'cancel', label: '取消' },
        { value: 'ok', label: '删除', primary: true },
      ],
    });
    if (v === 'ok' && (await run({ op: 'remove_country', id: m.id }, '正在计算…'))) {
      selectedCountry.value = null;
      sheet.value = null;
    }
  };
  const tab = countryTab.value;
  return (
    <div class="country-archive">
      <div class="row arch-head">
        <Flag m={m} w={36} h={24} />
        <span class="grow item-text">
          <b>{m.name}</b>
          <span class="hint">{[tierLabel(w, m), m.orig].filter(Boolean).join(' · ')}</span>
        </span>
        <button class="icon-btn" onClick={() => focusOn(cellsOf(w, m.id))} title="定位">
          <ScanSearch />
        </button>
      </div>
      <Toggle on={!!m.locked} onChange={(locked) => void patch(m.id, { locked })} title="重新生成国家时领土、档案都不动">
        {m.locked ? <Lock /> : <LockOpen />} 锁定
      </Toggle>
      <Seg<CountryTab> value={tab} options={COUNTRY_TABS} onChange={(t) => (countryTab.value = t)} wide />
      {tab === 'overview' && (
        <>
          <Glance w={w} m={m} />
          <NameSection m={m} />
          <ColorCapital w={w} m={m} />
          <FlagSection w={w} m={m} />
          <TerritorySection w={w} m={m} remove={() => void remove()} />
        </>
      )}
      {tab === 'politics' && (
        <>
          <GovernmentSection w={w} m={m} />
          <CultureSection w={w} m={m} />
          <FactionSection w={w} m={m} />
          <RulerSection m={m} />
        </>
      )}
      {tab === 'people' && (
        <>
          <StatsSection w={w} m={m} />
          <CitySection w={w} m={m} />
        </>
      )}
      {tab === 'relations' && <DiplomacySection w={w} m={m} />}
      {/* 历史按国家重建（第四十轮：只这一段）：没提交的字在卸下时写进原来那一国 */}
      {tab === 'history' && <HistorySection key={m.id} m={m} />}
    </div>
  );
}

registerArchive('country', { title: () => '国家档案', body: CountryArchive });
