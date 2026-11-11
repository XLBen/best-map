import { render } from 'preact';
import { disallowScripts } from '../core/script';
import { crashState } from './crash-host';
import { installSmokeHooks } from './smoke-hooks';
import { startMishaps } from './state';
import { App } from './ui/App';
import { RootGuard } from './ui/shell/Guard';
import { startToolEffects } from './ui/defs/tools';
import { startSaveNotes } from './ui/shell/save-note';
// 第三批几处的口子（滑块的即时外观、自己写的脚本的信任、出错提示的“编辑”）
import './ui/connect';
import './styles.css';
import './ui/packs/lib-panel.css';
import './ui/packs/lib-seen.css';
import './ui/packs/lib-find.css';
import './ui/packs/lib-pick.css';
import './ui/packs/lib-text.css';
import './ui/packs/lib-form.css';
import './ui/archives/lore.css';
import './ui/shell/crash.css';
import './ui/shell/progress.css';
// 手绘画风的楷体（第八十七轮）：霞鹜文楷（OFL），按 unicode-range 切成 97 个小文件，只下载画到的字所在的那几个；
// font-display: swap，不挡第一次画。只是 @font-face 的声明，没用到时一个文件都不下载
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css';

// 用户的脚本只在引擎的 Worker 里跑：主线程上一编译就报错（脚本编辑器在这里只用 acorn 解析，不编译）
disallowScripts();

// 换工具、底图跟着状态变的几件事（以前在 defs/tools.ts 的模块里）：在第一次画界面之前
startToolEffects();
// 自动保存没存成、存储快满了时顶上说一次（第九十四轮）
startSaveNotes();

// 第九十六轮：全局的兜底（boot.ts 已经先接上了 window 的两个事件和整页的自救页）。这里把程序这边的几样接过去
// （state/mishap.ts：不致命的错从界面顶上说、自救页导出用的页面里现在的世界、出自救页之前马上写一次自动保存）
startMishaps();
// 冒烟用的钩子（只在网址带着冒烟的记号时才装，见 smoke-hooks.ts）
installSmokeHooks();

// index.html 里“页面还没打开”的那一句（程序的文件没读到时十秒后显出来）：程序起来了，拿掉
document.querySelector('.boot-wait')?.remove();
// RootGuard：整个界面画不出来时接住（整页的自救页），页面不会只是白的
render(
  <RootGuard>
    <App />
  </RootGuard>,
  document.getElementById('app')!,
);
// 画出来过了：之后没接住的错只是顶上说一句（之前的算致命：页面还是白的）
crashState.rendered = true;
