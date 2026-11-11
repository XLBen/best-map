import { SCRIPT_KIND_LABEL, type FoundScript } from '../../../core/script';
import { scriptTrustText } from '../copy';
import { isolationNote } from './script-trust';

// 资源包里的脚本：信任的问话、只读地查看源码（旧的生态文件导入时问的是 state.ts 的 confirmImport）


// 只读的源码，按所属（生态、河流类型……）和种类标出来
export function ScriptList({ scripts }: { scripts: FoundScript[] }) {
  return (
    <div>
      {scripts.map((s) => (
        <div>
          <div class="small">
            “{s.owner}”的{SCRIPT_KIND_LABEL[s.kind]}脚本
          </div>
          <pre class="script-src">{s.src}</pre>
        </div>
      ))}
    </div>
  );
}

// 信任的问话（资源包导入、用到世界前）：有几段脚本、会在哪里运行，可以展开看源码
export function TrustBlock({ scripts, what = '这个文件' }: { scripts: FoundScript[]; what?: string }) {
  return (
    <div class="box trust">
      <b>{what}里的脚本</b>
      <p class="small">{scriptTrustText(scripts.length)}</p>
      <p class="hint">{isolationNote()}</p>
      <details>
        <summary>脚本</summary>
        <ScriptList scripts={scripts} />
      </details>
    </div>
  );
}
