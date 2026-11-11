import { render } from 'preact';
import { disallowScripts } from '../core/script';
import { App } from './ui/App';
import { startToolEffects } from './ui/defs/tools';
// 第三批几处的口子（滑块的即时外观、自己写的脚本的信任、出错提示的“编辑”）
import './ui/connect';
import './styles.css';
import './ui/packs/lib-panel.css';
import './ui/packs/lib-seen.css';
import './ui/packs/lib-find.css';
import './ui/packs/lib-pick.css';
import './ui/packs/lib-text.css';
import './ui/archives/lore.css';
// 手绘画风的楷体（第八十七轮）：霞鹜文楷（OFL），按 unicode-range 切成 97 个小文件，只下载画到的字所在的那几个；
// font-display: swap，不挡第一次画。只是 @font-face 的声明，没用到时一个文件都不下载
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css';

// 用户的脚本只在引擎的 Worker 里跑：主线程上一编译就报错（脚本编辑器在这里只用 acorn 解析，不编译）
disallowScripts();

// 换工具、底图跟着状态变的几件事（以前在 defs/tools.ts 的模块里）：在第一次画界面之前
startToolEffects();

render(<App />, document.getElementById('app')!);
