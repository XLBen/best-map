// 把生成的地形退回第八十五轮（第八十六轮，测试用）：流量不按降水加权、没有干的洼地（elevation-precip.ts 的 precipOn），
// 冰川照旧在求解里按新建时的纬度挖（glacial-legacy.ts），山带的抬升不往中间集中（terrain.ts 的 BELT.M0 = 0），
// 大陆倾斜的衰减长度 0.2（relief.ts 的 RELIEF_TUNING），测试的新世界不加红树林。核对过：这样生成的世界与第八十五轮逐值相同（推导里只多了 derived.ice），
// 见 core/biome-legacy.test.ts、core/solver-identity.test.ts。
// 只给查别的东西（工具的命令流、画河的逻辑、约束求解……）、在第八十五轮的地形上找好了地方或录下了值的测试用：
// 在测试文件的最上面调用一次（开关是模块里的，每个测试文件各有一份）
import { precipOn } from '../elevation-precip';
import { glacialLegacy } from '../glacial-legacy';
import { RELIEF_TUNING } from '../relief';
import { BELT } from '../terrain';
import { fixtureFlags } from './fixtures';

export function useRound85Terrain(): void {
  precipOn.on = false;
  glacialLegacy.on = true;
  BELT.M0 = 0;
  RELIEF_TUNING.TILT_L = 0.2;
  // 红树林（第八十六轮的生态）不加进测试的新世界（fixtures.ts 的 seedCommands）
  fixtureFlags.noMangrove = true;
}

// 推导里多了冰盖（derived.ice）：和第八十五轮的摘要比的时候去掉
export const withoutIce = (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'derived.ice'));
