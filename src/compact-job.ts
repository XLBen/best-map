import { compactWorldDoc } from '../core/compact';
import { builtinPacks } from '../core/packs/builtin-tree';
import { findScripts } from '../core/script';
import { buildMeshFor } from '../core/world';
import type { CompactJob, CompactReply } from './protocol';

// 压缩世界文件（第二十九轮，导出世界、存进“我的地图”时）：在导出 Worker 里做（export-worker.ts），不占计算 Worker。
// 要从头重放两遍（原来的、压缩后的），核对一模一样才用（core/compact.ts）。
// 导出 Worker 不像计算 Worker 那样隔离（能碰到页面的存储）：世界里有不是内置的脚本时不重放、不压缩，原样写出去

// 内置的脚本（奇幻的生态、河、湖、星球形态……）：这些可以在这里运行
let builtinScripts: Set<string> | null = null;
export function onlyBuiltinScripts(json: unknown): boolean {
  builtinScripts ??= new Set(findScripts(builtinPacks()).map((s) => s.src));
  return findScripts(json).every((s) => builtinScripts!.has(s.src));
}

export function compactJob(job: CompactJob): CompactReply {
  if (!onlyBuiltinScripts(job.compact)) return { ok: true, skipped: '有自己写的脚本' };
  const r = compactWorldDoc(job.compact, { mesh: buildMeshFor(job.compact.settings) });
  return { ok: true, compacted: { doc: r.doc, changed: r.changed, verified: r.verified, dropped: r.dropped, removed: r.removed, kept: r.kept } };
}
