import { originSourceId, setOrigin } from '../content/origin';
import { clearAuto } from '../human/auto';
import type { World } from '../world';
import { setContent } from './features';
import type { Command } from './schema';
import { Dirty } from './shared';

// 换库（第五十二轮）：generate_human、regenerate_human 带着 switchLibrary 时，算好推导之后、生成之前做这一步。
// 放在生成的命令里而不是单独一条：用到这些项的人口、国家在这一步到生成之间是悬空的，中间不能重算推导。
// 名单由界面按资源库算好（core/packs/switch.ts），这里只照着做，计算 Worker 不碰内置的数据；重放时结果一样

type LibrarySwitch = NonNullable<Extract<Command, { op: 'regenerate_human' }>['switchLibrary']>;

// 生成之前的底子和新世界一样：群体的编号从头给（共用的群体留着旧编号时，人口的几格排法会不同）；自动的城市、地标都要换掉，
// 没有留下的（锁定的、自己放的）时编号也从头给。结果才和用新库新建的世界逐值相同（core/packs/switch.test.ts）
function freshStart(world: World): void {
  const { causes: c, small } = world;
  c.popTotal?.fill(0);
  c.popGroup?.fill(0);
  c.popShare?.fill(0);
  c.popManual?.fill(0);
  clearAuto(world);
  delete small.popGroups;
  const staying = (all: Record<string, { auto?: boolean; locked?: boolean }> | undefined) => Object.values(all ?? {}).some((x) => !x.auto || x.locked);
  if (staying(small.cities) || staying(small.roads) || staying(small.landmarks) || Object.keys(small.points ?? {}).length) return;
  delete small.cities;
  delete small.roads;
  delete small.landmarks;
  delete small.nextSettlement;
}

export function leaveLibrary(world: World, sw: LibrarySwitch): Dirty {
  freshStart(world);
  let dirty: Dirty = Dirty.None;
  for (const ref of sw.drop) {
    if (world.small.content?.[ref.kind]?.[ref.id] === undefined) continue;
    dirty = Math.max(dirty, setContent(world, ref.kind, ref.id, null, true).dirty) as Dirty;
  }
  for (const r of sw.rehome) setOrigin(world.small, r.kind, r.id, r.from, originSourceId(world.small, r.kind, r.id));
  return dirty;
}
