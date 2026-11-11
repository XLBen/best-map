import { useMemo, useState } from 'preact/hooks';
import { Flag } from '../panels/countries';
import type { Obj } from './fields';
import type { PageCtx, SourceRef } from './page-source';
import { FLAG_WORDS, LANDMARK_TOKENS, flagPreview, landmarkSamples } from './previews';
import { replaceTitles } from './page-actions';
import { TITLE_MAX, governmentsIn, replaceNote, replacePlan } from './title-help';

// 表单旁的小预览（第九十轮，逻辑在 previews.ts）：地标“名字的写法”的示例、政体的旗；
// 第九十一轮：政体“称号”一段下面的“把一个称号都换掉”（逻辑在 title-help.ts）

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

// 把一个称号都换掉（第九十一轮）：这一份（本世界或我的库）各政体的称号、统治者称号、换说法里整个写着这个词的地方一次改完。
// 写着词的时候下面就说会改几处；点“替换”是一步，能撤销
export function TitleReplace({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const govs = useMemo(() => governmentsIn(src, ctx), [src.t, src.t === 'lib' ? src.key : '', ctx.world, ctx.lib]);
  const plan = replacePlan(govs, from, to);
  const note = replaceNote(govs, from, to);
  const run = async () => {
    if (!plan || busy) return;
    setBusy(true);
    const n = await replaceTitles(src, plan.from, plan.to, ctx);
    setBusy(false);
    if (n) {
      setFrom('');
      setTo('');
    }
  };
  return (
    <section class="ed-samples lp-title-replace">
      <b class="small">把一个称号都换掉</b>
      <div class="row">
        <input type="text" value={from} maxLength={TITLE_MAX} placeholder="国王" aria-label="原来的称号" onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
        <span class="hint">换成</span>
        <input type="text" value={to} maxLength={TITLE_MAX} placeholder="大汗" aria-label="新的称号" onInput={(e) => setTo((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void run()} />
        <button class="small" disabled={!plan || busy} onClick={() => void run()}>
          替换
        </button>
      </div>
      {note && <p class="hint">{note}</p>}
      <p class="hint">{src.t === 'world' ? '改遍这张地图的政体；只换整个是这个词的' : '改遍这个库的政体；只换整个是这个词的'}</p>
    </section>
  );
}
