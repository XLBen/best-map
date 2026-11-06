import type { Category } from '../../state';
import { panelOf } from '../defs/panel-registry';
import { CATEGORY_DEFS } from '../defs/tools';

// 底部工具条末尾“⋯”弹出的：这一类的设置（自动划分规则、文字包、没涂成的地方……）

export function CategoryMore({ c }: { c: Category }) {
  const key = CATEGORY_DEFS[c].extras;
  const Extras = key ? panelOf(key) : null;
  return Extras ? (
    <div class="extras">
      <Extras />
    </div>
  ) : null;
}
