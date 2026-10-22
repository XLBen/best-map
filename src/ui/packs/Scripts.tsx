import { SCRIPT_KIND_LABEL, type FoundScript } from '../../../core/script';
import { scriptsIsolated } from '../../state';

// 资源包里的脚本：信任的问话、只读地查看源码（旧的生态文件导入时问的是 state.ts 的 confirmImport）

// 脚本是不是在隔离的环境里跑（state.ts 的 scriptsIsolated：计算 Worker 从 data: 地址开、自查三项全部通过）。没隔离时老实说
export function isolationNote(): string {
  return scriptsIsolated.value ? '脚本在隔离的环境里运行，读不到你保存的其他世界，也不能联网。' : '当前环境不能把脚本隔离运行：脚本能读到这个浏览器里保存的世界。';
}

// 只读的源码，按所属（生态、河流类型……）和种类标出来
export function ScriptList({ scripts }: { scripts: FoundScript[] }) {
  return (
    <div class="script-list">
      {scripts.map((s) => (
        <div class="script-item">
          <div class="small">
            「{s.owner}」的{SCRIPT_KIND_LABEL[s.kind]}脚本
          </div>
          <pre class="script-src">{s.src}</pre>
        </div>
      ))}
    </div>
  );
}

// 信任的问话（资源包导入、用到世界前）：有几段脚本、会在哪里运行，可以展开看源码
export function TrustBlock({ scripts, what = '资源包' }: { scripts: FoundScript[]; what?: string }) {
  return (
    <div class="box trust">
      <b>信任这个{what}吗？</b>
      <p class="small">
        这个{what}里有 {scripts.length} 段脚本（作者写的小程序），会在你的电脑上运行。只导入你信任的人做的{what}。
      </p>
      <p class="muted small">{isolationNote()}</p>
      <details>
        <summary>查看脚本</summary>
        <ScriptList scripts={scripts} />
      </details>
    </div>
  );
}
