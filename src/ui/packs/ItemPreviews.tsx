import { useMemo, useState } from 'preact/hooks';
import { Flag } from '../panels/countries';
import type { Obj } from './fields';
import type { PageCtx, SourceRef } from './page-source';
import { FLAG_WORDS, LANDMARK_TOKENS, flagPreview, landmarkSamples } from './previews';

// 表单旁的小预览（第九十轮，逻辑在 previews.ts）：地标“名字的写法”的示例、政体的旗

// 地标名字的示例：每种写法一行（默认的、按文化换的），跟着正在改的写法变
export function LandmarkNameSamples({ item, src, ctx }: { item: Obj; src: SourceRef; ctx: PageCtx }) {
  const list = useMemo(() => landmarkSamples(item, src, ctx), [item.label, item.name, src.t, ctx.world, ctx.lib]);
  return (
    <section class="ed-samples">
      <b class="small">示例</b>
      {list.map((s) => (
        <div class="ed-sample" key={s.who}>
          <span class="hint ellipsis">{s.who}</span>
          <span>
            {s.zh}
            {s.orig ? `　${s.orig}` : ''}
          </span>
        </div>
      ))}
      <p class="hint">能写的词：{LANDMARK_TOKENS.map((t) => `{${t}}`).join(' ')}</p>
      <p class="hint">{src.t === 'world' ? '词换成地标附近的名字；这里用的是地图上的' : '词换成地标附近的名字'}</p>
    </section>
  );
}

// 政体的旗：按写的纹章、样式生成的几面，“换一批”再看几面
export function FlagSamples({ item }: { item: Obj }) {
  const [seed, setSeed] = useState(1);
  const p = useMemo(() => flagPreview(item, seed), [item.emblems, item.layouts, item.category, seed]);
  return (
    <section class="ed-samples">
      <b class="small">示例</b>
      <div class="row wrap lp-flag-samples">
        {p.flags.map((f, k) => (
          <Flag key={k} m={{ flag: f }} w={45} h={30} />
        ))}
        <button class="small" onClick={() => setSeed(seed + 1)}>
          换一批
        </button>
      </div>
      {p.unknown.length > 0 && <p class="hint warn">不认识：{p.unknown.join('、')}</p>}
      <p class="hint">纹章能写：{FLAG_WORDS.emblems.join('、')}</p>
      <p class="hint">样式能写：{FLAG_WORDS.layouts.join('、')}</p>
      <p class="hint">颜色跟着国家；空着时按政体的类别挑</p>
    </section>
  );
}
