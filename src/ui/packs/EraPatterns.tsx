import { ChevronRight, X } from 'lucide-preact';
import { useContext, useMemo } from 'preact/hooks';
import { kindOf } from '../../../core/content/registry';
import { patternModule } from '../../../core/human';
import { FieldsBox } from './ContentEditor';
import { type PatternChoice, NATIONALISM_FIELD, addablePatterns, amountField, eraPatternRows, withPattern, withPatternAmount, withoutPattern } from './era-patterns';
import type { Obj } from './fields';
import { type PageCtx, type SourceRef, rowsOf } from './page-source';
import { RefGo } from './RefPicker';

// 时代页面“国家”一段里的国家格局与文化的倒向（第七十五轮）：一种格局一个“多少”的滑块，右边打开、去掉；下面加一种；最后是文化的倒向。
// 改了交给页面的 save（本世界一条命令，我的库走它的撤销；只读的库整段在 fieldset disabled 里）
export function EraPatterns({ era, src, ctx, onChange }: { era: Obj; src: SourceRef; ctx: PageCtx; onChange: (next: Obj) => void }) {
  const kind = kindOf('countryPattern');
  const rowsSrc = kind ? rowsOf(src, kind, ctx) : null;
  const choices = useMemo(() => (rowsSrc ?? []).map((r) => r.item as PatternChoice), [rowsSrc]);
  const rows = eraPatternRows(era, choices);
  const add = addablePatterns(era, choices);
  const go = useContext(RefGo);
  return (
    <div class="ed-fields lp-era-patterns">
      <div class="ed-label">国家格局</div>
      {rows.map((r) => {
        const open = r.missing ? null : (go?.('countryPattern', r.id) ?? null);
        return (
          <div class={`ed-sparse ${r.missing ? 'faint' : ''}`} key={`${r.index}:${r.id}`}>
            <FieldsBox fields={[amountField(r)]} value={{ amount: r.amount }} onChange={(o) => typeof o.amount === 'number' && onChange(withPatternAmount(era, r.index, o.amount))} issues={[]} />
            {open && (
              <a class="ref-go" role="button" title="打开这一项" onClick={open}>
                <ChevronRight />
              </a>
            )}
            <button class="small icon ghost" title="删除" onClick={() => onChange(withoutPattern(era, r.index))}>
              <X />
            </button>
          </div>
        );
      })}
      {!rows.length && <p class="hint">没有国家格局：没有帝国、联邦、同盟，附庸照旧</p>}
      {add.length > 0 && (
        <select
          class="small ed-add"
          value=""
          onChange={(e) => {
            const id = (e.target as HTMLSelectElement).value;
            (e.target as HTMLSelectElement).value = '';
            const next = id ? withPattern(era, id) : null;
            if (next) onChange(next);
          }}
        >
          <option value="">加一种格局</option>
          {add.map((c) => (
            <option value={c.id} title={c.description}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <FieldsBox fields={[NATIONALISM_FIELD]} value={era} onChange={onChange} issues={[]} />
    </div>
  );
}

// 国家格局页面“基本”一段的下面（第七十五轮）：选着的模块做什么、“多少”是什么意思
export function PatternTip({ item }: { item: Obj }) {
  const m = typeof item.module === 'string' ? patternModule(item.module) : undefined;
  if (!m) return null;
  return (
    <div class="lp-pattern-tip">
      <p class="hint">{m.tip ?? m.description}</p>
      <p class="hint">多少：{m.amountHint}</p>
    </div>
  );
}
