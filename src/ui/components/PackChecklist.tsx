import { ChevronDown, ChevronRight } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { type PackNode, subPacks } from '../../../core/packs';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { type HumanChoice, NO_ERA, choosePack, chooseRule } from '../human';
import { hasEra, libRoots, packHint, packState, pathKey, rulePack, samePath, underPath } from '../packChoice';

// 勾选资源包（第三十轮界面）：新建向导的“内容”、“文化 ⋯”里的生成人文与“换时代、文化组…”共用。
// 资源库的包按树一行一项（勾选框、名字、灰色的种类，右边“规则”或“设为规则”）；勾上一个包就是整个包，下面的小包变灰。
// 下面一行写规则与维度来自哪个包；勾选的包里没有时代时写“不生成人文”

const INDENT = 12;

interface Ctx {
  choice: HumanChoice;
  onChange: (c: HumanChoice) => void;
  lib: readonly LibraryEntry[];
  disabled?: boolean;
  open: Set<string>;
  toggle: (key: string) => void;
  rule?: string[];
}

function PackRow({ node, path, depth, ctx }: { node: PackNode; path: string[]; depth: number; ctx: Ctx }) {
  const st = packState(ctx.choice.packs, path);
  const kids = subPacks(node);
  const key = pathKey(path);
  const open = ctx.open.has(key);
  const era = st === 'on' && hasEra(node);
  const isRule = !!ctx.rule && samePath(ctx.rule, path);
  return (
    <>
      <div class={`repo-row pack-row ${st === 'covered' ? 'covered' : ''}`} style={{ paddingLeft: `${depth * INDENT}px` }}>
        {kids.length ? (
          <button class="repo-twist" onClick={() => ctx.toggle(key)} title={open ? '收起' : '展开'}>
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
        ) : (
          <span class="repo-twist" />
        )}
        <label class="pack-check" title={st === 'covered' ? '整个上一层的包已勾上' : node.description}>
          <input
            type="checkbox"
            checked={st === 'on' || st === 'covered'}
            disabled={ctx.disabled || st === 'covered'}
            ref={(el) => {
              if (el) el.indeterminate = st === 'partial';
            }}
            onChange={() => ctx.onChange(choosePack(ctx.choice, path, st !== 'on', ctx.lib))}
          />
          <span class="pack-name">{node.name}</span>
        </label>
        <span class="hint repo-count">{packHint(node)}</span>
        {era && (
          <span class="repo-actions">
            {isRule ? (
              <span class="tag ok" title="人口密度、国家大小、城市化、维度……按这个包的时代">
                规则
              </span>
            ) : (
              <button class="small ghost" disabled={ctx.disabled} title="规则与维度改用这个包的时代" onClick={() => ctx.onChange(chooseRule(ctx.choice, path))}>
                设为规则
              </button>
            )}
          </span>
        )}
      </div>
      {open && kids.map((c) => <PackRow key={c.id} node={c} path={[...path, c.id]} depth={depth + 1} ctx={ctx} />)}
    </>
  );
}

// compact：弹出面板里（窄），开始时都收着
export function PackChecklist({
  choice,
  onChange,
  lib,
  small,
  disabled,
  compact,
}: {
  choice: HumanChoice;
  onChange: (c: HumanChoice) => void;
  lib: readonly LibraryEntry[];
  small?: World['small'] | null;
  disabled?: boolean;
  compact?: boolean;
}) {
  const roots = libRoots(lib);
  // 展开着的：开始时是下面有勾着的小包的大包（弹出面板里都收着）
  const [open, setOpen] = useState<Set<string>>(() => new Set(compact ? [] : roots.filter((r) => choice.packs.some((p) => p.length > 1 && underPath(p, [r.key]))).map((r) => r.key)));
  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };
  const rule = rulePack(choice.packs, lib, small);
  const ctx: Ctx = { choice, onChange, lib, disabled, open, toggle, rule: rule?.path };
  return (
    <div class="pack-checklist">
      <div class="pack-tree">
        {roots.map((r) => (
          <PackRow key={r.key} node={r.pack} path={[r.key]} depth={0} ctx={ctx} />
        ))}
      </div>
      {rule ? (
        <p class="hint" title="勾选的包合起来用：规则与维度取第一个时代包的，别的包添上政体、派系、文化……">
          规则与维度：<b>{rule.name}</b>
          {rule.era.dimensions.length ? ` · 人口分${['文化', ...rule.era.dimensions.map((d) => d.label)].join('、')}` : ''}
        </p>
      ) : (
        <p class="hint warn">{NO_ERA}</p>
      )}
    </div>
  );
}
