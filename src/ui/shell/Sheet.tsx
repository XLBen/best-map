import { X } from 'lucide-preact';
import { sheet } from '../../state';
import { archiveOf } from '../defs/archive-registry';

// 右边的抽屉：生态类型编辑、国家的档案（第二十三轮）、城市、地标、自定义点的档案（第二十四轮）、帝国、联邦、同盟的档案（第二十六轮）。
// 点地图不会关上，可以一边改一边看地图怎么变。第七十轮：标题和内容由各档案登记（defs/archive-registry.ts），这里不引用具体的档案

export function Sheet() {
  const s = sheet.value;
  if (!s) return null;
  const a = archiveOf(s);
  const title = a.title();
  const Body = a.body;
  return (
    <div class="sheet">
      <div class="popover-head">
        <b>{title}</b>
        <button class="icon-btn" onClick={() => (sheet.value = null)} title="关闭">
          <X />
        </button>
      </div>
      <div class="sheet-body">
        <Body />
      </div>
    </div>
  );
}
