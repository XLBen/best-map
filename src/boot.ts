import { crashHooks, installCrashHandlers } from './crash-host';
import { rescueShown, showRescue } from './rescue';

// 页面最先载入的一小段（第九十六轮；index.html 里排在 main.tsx 前面）：接上全局的兜底——没接住的错、没读到的程序文件。
// 单独一个入口，是为了程序的主体（main.tsx 连同它引用的全部）载入、运行出错时这里已经在了：页面不会只是白的。
// 只引用 crash-host.ts、rescue.ts 和它们用的几个纯文件，不引用界面、状态、资源库、渲染器

crashHooks.fatal = showRescue;
installCrashHandlers();

// 自救页开着时键盘不再到下面的程序（撤销、保存、换工具的快捷键都在 window 上听着）。这里登记得最早，捕获阶段最先收到；
// 不拦默认的行为：Tab、回车照样在自救页的按钮上起作用
window.addEventListener(
  'keydown',
  (e) => {
    if (rescueShown()) e.stopImmediatePropagation();
  },
  true,
);
