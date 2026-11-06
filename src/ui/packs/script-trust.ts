import { scriptsIsolated } from '../../state';

// 第六十九轮从 Scripts.tsx 搬来（问话、资源包的信任都写这一句）

// 脚本是不是在隔离的环境里跑（state.ts 的 scriptsIsolated：计算 Worker 从 data: 地址开、自查三项全部通过）。没隔离时老实说
export function isolationNote(): string {
  return scriptsIsolated.value ? '脚本隔离运行，读不到其他世界，不能联网。' : '脚本没有隔离：能读到浏览器里的世界，也能联网。';
}
