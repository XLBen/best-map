import type { World } from '../../../core/world';
import { library } from '../../library';
import { openPanel } from '../../state';
import { ERA_PAGE_TIP, GEN_RULES_NOTE } from '../copy';
import { eraPage, openEraPage } from '../packs/open-era';

// 生成人文、国家的面板上的一句（第七十七轮）：参数在资源库里改。能打开时带一个“时代”按钮（新建向导里不带：资源库在向导后面）
export function EraRulesNote({ libraryKey, small, seg, button = true }: { libraryKey: string | null; small: World['small'] | null | undefined; seg: 'state' | 'people'; button?: boolean }) {
  const lib = library.value;
  const can = button && !!eraPage(libraryKey, small, lib, seg);
  return (
    <div class="row between">
      <span class="hint">{GEN_RULES_NOTE}</span>
      {can && (
        <button
          class="link-btn small"
          title={ERA_PAGE_TIP}
          onClick={() => {
            openPanel.value = null;
            openEraPage(libraryKey, small, lib, seg);
          }}
        >
          时代
        </button>
      )}
    </div>
  );
}
