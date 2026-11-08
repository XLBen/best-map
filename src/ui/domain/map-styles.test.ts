import { describe, expect, it } from 'vitest';
import { worldMapStyle, worldMapStyleId } from '../../../core/map-style';
import { DRAWN_PACK, builtinPacks } from '../../../core/packs/builtin-tree';
import { HAND_STYLE_ID } from '../../../core/packs/map-styles';
import { continents } from '../../../core/testing/fixtures';
import type { LibraryEntry } from '../../library';
import { mapStyleChoices, mapStyleCommand } from './map-styles';

// 第八十七轮：“图层 → 画风”里列着世界用的库里的手绘（新世界不带它），点它时从库里加进世界并选上，一整步

const LIB: LibraryEntry[] = builtinPacks().map((p) => ({ key: p.id, pack: p, builtin: true, mine: false, installedAt: 0 }));

describe('画风的选择', () => {
  it('新世界只有写实、地图册；选择里多一个从库里加的手绘', () => {
    const eng = continents();
    const w = eng.world;
    expect(Object.keys(w.small.content?.mapStyle ?? {})).toEqual(['realistic', 'atlas']);
    const list = mapStyleChoices(w.small, LIB);
    expect(list.map((c) => c.style.id)).toEqual(['realistic', 'atlas', HAND_STYLE_ID]);
    expect(list[2].path?.slice(1)).toEqual([DRAWN_PACK]);
  });

  it('点手绘：加进世界并选上（一整步，撤销一次回到原样）；再点写实只换画风', () => {
    const eng = continents();
    const before = structuredClone(eng.world.small.content?.mapStyle);
    const list = mapStyleChoices(eng.world.small, LIB);
    const cmd = mapStyleCommand(eng.world, list.find((c) => c.style.id === HAND_STYLE_ID)!, LIB)!;
    expect(cmd.op).toBe('batch');
    eng.exec(cmd);
    expect(worldMapStyleId(eng.world.small)).toBe(HAND_STYLE_ID);
    expect(worldMapStyle(eng.world.small).mountains).toBe(true);
    // 加进来以后它就是世界里的，不再从库里加
    const again = mapStyleChoices(eng.world.small, LIB);
    expect(again.map((c) => [c.style.id, !!c.path])).toEqual([
      ['realistic', false],
      ['atlas', false],
      [HAND_STYLE_ID, false],
    ]);
    expect(mapStyleCommand(eng.world, again[2], LIB)).toBeNull();
    expect(mapStyleCommand(eng.world, again[0], LIB)).toEqual({ op: 'set_map_style', id: 'realistic' });
    eng.undo();
    expect(eng.world.small.content?.mapStyle).toEqual(before);
    expect(worldMapStyleId(eng.world.small)).toBe('realistic');
  });
});
