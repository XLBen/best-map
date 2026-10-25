import { ScanSearch, Trash2, X } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import { BLOC_NAMES, blocById } from '../../core/human';
import type { Bloc, World } from '../../core/world';
import { askUser, exec, nameMode, selectedBloc, world } from '../state';
import { focusOn } from './camera';
import { Line, TextField } from './CountryArchive';
import { BLOC_KIND_OPTIONS, blocCellsOf, blocCommand, blocMembers, blocNamePatch, removeBlocCommand, selectBloc } from './blocs';
import { Seg } from './common';
import { withId, withoutId } from './countries';
import { showCountry } from './panels/countries';

// 集团的档案（第二十六轮）：帝国、联邦、同盟。名字与原文、种类、盟主、成员、颜色、删除。改的都是 set_bloc

const run = (cmd: Command | null) => (cmd ? exec(cmd, '正在保存…') : Promise.resolve(false));

function NameLines({ b }: { b: Bloc }) {
  const [orig, setOrig] = useState(b.orig ?? '');
  useEffect(() => setOrig(b.orig ?? ''), [b.id, b.orig]);
  const patch = (name: string, o: string) => {
    const p = blocNamePatch(b, name, o);
    return run(p ? blocCommand(b.id, p) : null);
  };
  return (
    <section>
      <h5>名字</h5>
      <Line label="中文">
        <TextField value={b.name} onCommit={(v) => void patch(v, orig)} placeholder="空着恢复自动" />
      </Line>
      <Line label="原文">
        <TextField value={b.orig ?? ''} maxLength={80} onCommit={(v) => (setOrig(v), void patch(b.name, v))} placeholder="原文" />
      </Line>
      <div class="row between">
        <span class="hint">{b.nameLocked ? '改过名字：换盟主时不变' : '按盟主的地名自动起'}</span>
        {b.nameLocked && (
          <button class="small" onClick={() => void run(blocCommand(b.id, { name: '' }))}>
            恢复自动
          </button>
        )}
      </div>
    </section>
  );
}

function Members({ w, b }: { w: World; b: Bloc }) {
  const members = blocMembers(w, b);
  const others = Object.values(w.small.countries ?? {})
    .filter((m) => !b.members.includes(m.id))
    .sort((a, c) => a.name.localeCompare(c.name, 'zh'));
  const set = (ids: number[]) => void run(blocCommand(b.id, { members: ids }));
  return (
    <section>
      <h5>成员 · {members.length} 国</h5>
      <Line label="盟主">
        <select class="grow" value={b.leader} onChange={(e) => void run(blocCommand(b.id, { leader: Number((e.target as HTMLSelectElement).value) }))}>
          {members.map((m) => (
            <option value={m.id}>{m.name}</option>
          ))}
        </select>
      </Line>
      <div class="chips">
        {members.map((m) => (
          <span class="chip static">
            <span class="swatch" style={{ background: m.color }} />
            <button class="link" onClick={() => showCountry(w, m.id)}>
              {m.name}
            </button>
            {members.length > 1 && (
              <button class="icon-btn" onClick={() => set(withoutId(b.members, m.id))} title="退出">
                <X />
              </button>
            )}
          </span>
        ))}
        {others.length > 0 && (
          <select
            class="chip-add"
            value=""
            onChange={(e) => {
              const v = Number((e.target as HTMLSelectElement).value);
              if (v) set(withId(b.members, v));
            }}
          >
            <option value="">加一国</option>
            {others.map((m) => (
              <option value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
      </div>
    </section>
  );
}

export function BlocArchive() {
  const w = world.value;
  const id = selectedBloc.value;
  const b = w && id !== null ? blocById(w.small, id) : undefined;
  void nameMode.value;
  if (!w || !b) return <p class="hint">没有选中</p>;
  const remove = async () => {
    const v = await askUser({
      title: `删除${BLOC_NAMES[b.kind]}`,
      text: `“${b.name}”的成员照旧各是一国。可以撤销。`,
      choices: [
        { value: 'cancel', label: '取消' },
        { value: 'ok', label: '删除', primary: true },
      ],
    });
    if (v === 'ok' && (await run(removeBlocCommand(b.id)))) selectBloc(null);
  };
  return (
    <div class="country-archive" key={b.id}>
      <div class="row arch-head">
        <span class="swatch" style={{ background: b.color }} />
        <span class="grow item-text">
          <b>{b.name}</b>
          {b.orig && <span class="hint">{b.orig}</span>}
        </span>
        <button class="icon-btn" onClick={() => focusOn(blocCellsOf(w, b))} title="定位">
          <ScanSearch />
        </button>
        <button class="icon-btn" onClick={() => void remove()} title={`删除${BLOC_NAMES[b.kind]}`}>
          <Trash2 />
        </button>
      </div>
      <NameLines b={b} />
      <section>
        <Line label="种类">
          <Seg value={b.kind} options={BLOC_KIND_OPTIONS} onChange={(kind) => kind !== b.kind && void run(blocCommand(b.id, { kind }))} titles={{ empire: '成员各自一色，外沿一道边线', federation: '成员在地图上是一种颜色', alliance: '同盟模式里一种颜色' }} />
        </Line>
        <Line label="颜色">
          <input type="color" value={b.color} onChange={(e) => void run(blocCommand(b.id, { color: (e.target as HTMLInputElement).value }))} />
        </Line>
      </section>
      <Members w={w} b={b} />
    </div>
  );
}
