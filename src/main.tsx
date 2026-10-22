import { render } from 'preact';
import { disallowScripts } from '../core/script';
import { App } from './ui/App';
// 第三批几处的口子（滑块的即时外观、自己写的脚本的信任、出错提示的“编辑”）
import './ui/connect';
import './styles.css';

// 用户的脚本只在引擎的 Worker 里跑：主线程上一编译就报错（脚本编辑器在这里只用 acorn 解析，不编译）
disallowScripts();

render(<App />, document.getElementById('app')!);
