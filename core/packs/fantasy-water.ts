import type { RiverType } from '../river-types';

// 奇幻库的六种新河（第五十七轮），各配一种奇幻生态（见 packs/fantasy-biomes.ts，表和理由见 docs/dev/history/第57轮.md）：
//   灵脉河  水晶丛林       星辉河  神圣之地里源头高的    圣泉河  神圣之地
//   毒液河  死亡森林       枯骨河  血腥之地              虫胶河  虫群占领区
//
// 整条河一种（match 脚本，每条河算一次），不按每格：奇幻生态只占陆地的百分之零点几到两三，按每格的话多半不到一段的长度（4 格），
// 并进相邻的段就没了。河流经的格里这种生态占到一定比例，整条就是这一种。
// 只写了 radiusKm 的岸边没有影响，不改气候。放在奇幻库原有的四种河前面：它们窄，血河按噪声铺得宽

const script = (src: string) => ({ api: 1 as const, src });

export const FANTASY_NEW_RIVER_TYPES: RiverType[] = [
  {
    id: 'ley_river',
    name: '灵脉河',
    color: '#5fe0c8',
    atlasColor: '#3f9c8c',
    style: 'glow',
    width: 0.9,
    names: [{ p: '{myth}灵脉' }, { p: '{color}灵川' }],
    scripts: { match: script(['// 流过水晶丛林的河', "return biome('crystal_jungle') >= 0.2;"].join('\n')) },
    seedKey: 'fantasy/ley_river',
    natural: true,
  },
  {
    id: 'starlight_river',
    name: '星辉河',
    color: '#c4ccff',
    atlasColor: '#7d86b8',
    style: 'glow',
    width: 0.9,
    names: [{ p: '{myth}星河' }, { p: '{quality}辉川' }],
    scripts: { match: script(['// 从高处的神圣之地流下来的河', "return biome('holy_land') >= 0.15 && sourceElevation > 2500;"].join('\n')) },
    seedKey: 'fantasy/starlight_river',
    natural: true,
  },
  {
    id: 'holy_spring',
    name: '圣泉河',
    color: '#f0e6a8',
    atlasColor: '#b8a45a',
    style: 'double',
    names: [{ p: '圣{nature}泉' }, { p: '{myth}圣川' }],
    scripts: { match: script(['// 流过神圣之地的河', "return biome('holy_land') >= 0.2;"].join('\n')) },
    seedKey: 'fantasy/holy_spring',
    natural: true,
  },
  {
    id: 'venom_river',
    name: '毒液河',
    color: '#8fd13a',
    atlasColor: '#6d8f2a',
    names: [{ p: '{color}毒川' }, { p: '{animal}涎河' }],
    scripts: { match: script(['// 流过死亡森林的河：树是它毒死的', "return biome('dead_forest') >= 0.2;"].join('\n')) },
    seedKey: 'fantasy/venom_river',
    natural: true,
  },
  {
    id: 'lac_river',
    name: '虫胶河',
    color: '#b8862a',
    atlasColor: '#96702a',
    width: 1.1,
    names: [{ p: '{animal}胶河' }, { p: '{color}虫川' }],
    scripts: { match: script(['// 流过虫群占领区的河', "return biome('swarm_zone') >= 0.2;"].join('\n')) },
    seedKey: 'fantasy/lac_river',
    natural: true,
  },
  {
    id: 'bone_river',
    name: '枯骨河',
    color: '#d9d2c0',
    atlasColor: '#a89f88',
    style: 'dashed',
    names: [{ p: '枯{plant}河' }, { p: '{color}骨川' }],
    scripts: { match: script(['// 流过血腥之地的河：两岸都是骨头', "return biome('bloody_land') >= 0.2;"].join('\n')) },
    seedKey: 'fantasy/bone_river',
    natural: true,
  },
];
