import { CommandError } from '../errors';
import { addEvent, removeEvent, setEvent } from '../human/events';
import { addDynasty, addRuler, moveRuler, removeDynasty, removeRuler, setCountryNote, setDynasty, setRuler } from '../human/rulers';
import type { World } from '../world';
import { countryLabel } from './human';
import type { Command } from './schema';
import { Dirty, type RunResult } from './shared';

// 国家的档案的命令（第八十五轮）：备注、统治者、家族、大事。只改 small.archive（换成新的对象），不改地图（Dirty.None），没有数组；
// 撤销、重做和别的命令一样（撤销记录里留着改之前的档案对象）。不是这一类的命令返回 undefined

const needCountries = (world: World) => {
  if (!world.small.countries) throw new CommandError('还没有国家');
};

export function runArchiveOp(world: World, cmd: Command): RunResult | undefined {
  switch (cmd.op) {
    case 'set_country_note': {
      needCountries(world);
      return { dirty: Dirty.None, summary: `国家${countryLabel(world, cmd.id)} · ${setCountryNote(world, cmd.id, cmd.note)}` };
    }
    case 'add_ruler': {
      needCountries(world);
      return { dirty: Dirty.None, summary: `国家${countryLabel(world, cmd.id)} · ${addRuler(world, cmd.id, cmd.ruler, cmd.at).summary}` };
    }
    case 'set_ruler':
      needCountries(world);
      return { dirty: Dirty.None, summary: setRuler(world, cmd.id, cmd.ruler, cmd.patch) };
    case 'remove_ruler':
      needCountries(world);
      return { dirty: Dirty.None, summary: removeRuler(world, cmd.id, cmd.ruler) };
    case 'move_ruler':
      needCountries(world);
      return { dirty: Dirty.None, summary: moveRuler(world, cmd.id, cmd.ruler, cmd.to) };
    case 'add_dynasty':
      needCountries(world);
      return { dirty: Dirty.None, summary: `国家${countryLabel(world, cmd.id)} · ${addDynasty(world, cmd.id, { name: cmd.name, orig: cmd.orig, founder: cmd.founder }).summary}` };
    case 'set_dynasty':
      needCountries(world);
      return { dirty: Dirty.None, summary: setDynasty(world, cmd.id, cmd.dynasty, cmd.patch) };
    case 'remove_dynasty':
      needCountries(world);
      return { dirty: Dirty.None, summary: removeDynasty(world, cmd.id, cmd.dynasty) };
    case 'add_event':
      needCountries(world);
      return { dirty: Dirty.None, summary: addEvent(world, cmd.event).summary };
    case 'set_event':
      return { dirty: Dirty.None, summary: setEvent(world, cmd.event, cmd.patch) };
    case 'remove_event':
      return { dirty: Dirty.None, summary: removeEvent(world, cmd.event) };
  }
}
