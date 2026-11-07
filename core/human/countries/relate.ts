import type { Bloc } from '../../world';
import { autoBlocName, blocAreas, classOf, tidyBlocs } from '../blocs';
import type { GenContext, HumanStage } from '../context';
import { runPatterns } from './patterns';
import { countryPopScale, countryRun } from './stage';

// 帝国、联邦、同盟（第二十六轮；领土补齐之后、人口之前，只在重新长国家时）。第七十三轮从 blocs.ts 的 makeBlocs 搬来：
// 这里只备好集团一步共用的东西（g.bloc：共用的随机流 'blocs'、领土补齐之后的面积、这一次的集团），帝国、联邦、同盟是格局的 relate 钩子
// （patterns/holy-empire.ts、federation.ts、alliance.ts），按模块的先后调；最后整理、切过联邦时重算首都一带的人口倍数

function relateCountries(ctx: GenContext) {
  const plan = ctx.countries;
  if (!plan || plan.mode !== 'generate') return;
  const { world, era } = ctx;
  const small = world.small;
  const metas = small.countries;
  if (!metas || !world.causes.country) return;
  // 国家一步没走（测试里换掉了那一步）时另开一次：没有预留的地方、没有新建的档案
  const g = ctx.countryRun ?? countryRun(ctx, plan);
  const blocs: Bloc[] = [...(small.blocs ?? [])];
  g.bloc = {
    rand: g.shared('blocs'),
    area: blocAreas(world),
    blocs,
    nid: Math.max(0, ...blocs.map((b) => b.id)) + 1,
    inUnion: new Set<number>(blocs.filter((b) => classOf(b.kind) === 0).flatMap((b) => b.members)),
    inAlliance: new Set<number>(blocs.filter((b) => b.kind === 'alliance').flatMap((b) => b.members)),
    split: false,
    // 生成时世界的时代还没换上：按这一次的时代起名
    name: (b) => {
      const nm = autoBlocName(world, b, era, blocs);
      b.name = nm.zh;
      if (nm.orig) b.orig = nm.orig;
    },
  };
  runPatterns(g, 'relate');
  if (blocs.length) small.blocs = blocs;
  else delete small.blocs;
  tidyBlocs(world);
  if (g.bloc.split) ctx.popScale = countryPopScale(ctx);
}

export const blocsStage: HumanStage = { id: 'blocs', run: relateCountries };
