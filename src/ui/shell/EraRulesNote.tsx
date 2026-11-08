import { worldEra } from '../../../core/human';
import type { World } from '../../../core/world';
import { library } from '../../library';
import { openPanel } from '../../state';
import { ERA_PAGE_TIP, GEN_RULES_NOTE } from '../copy';
import { GEN_OPEN_TIP, GEN_TITLE } from '../packs/copy';
import { worldLibrary } from '../domain/packChoice';
import { eraPage, openEraPage, openGenSettings } from '../packs/open-era';

// 生成人文、国家的面板上的一句（第七十七轮）：参数在资源库里改。第八十一轮：世界里有这个时代时按钮打开“生成设置”（最常调的几项在一页上），
// 换了库（世界里还没有那个时代）时打开库里的时代；新建向导里不带按钮（向导里有“建好后打开生成设置”）
export function EraRulesNote({ libraryKey, small, seg, button = true }: { libraryKey: string | null; small: World['small'] | null | undefined; seg: 'state' | 'people'; button?: boolean }) {
  const lib = library.value;
  const here = !!small && !!worldEra(small) && (!libraryKey || libraryKey === worldLibrary(small));
  const can = button && (here || !!eraPage(libraryKey, small, lib, seg));
  return (
    <div class="row between">
      <span class="hint">{GEN_RULES_NOTE}</span>
      {can && (
        <button
          class="link-btn small"
          title={here ? GEN_OPEN_TIP : ERA_PAGE_TIP}
          onClick={() => {
            openPanel.value = null;
            if (here) openGenSettings();
            else openEraPage(libraryKey, small, lib, seg);
          }}
        >
          {here ? GEN_TITLE : '时代'}
        </button>
      )}
    </div>
  );
}
