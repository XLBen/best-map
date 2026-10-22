import { render } from 'preact';
import { disallowScripts } from '../core/script';
import { App } from './ui/App';
import './styles.css';

// 用户的脚本只在引擎的 Worker 里跑：主线程上一编译就报错（脚本编辑器在这里只用 acorn 解析，不编译）
disallowScripts();

render(<App />, document.getElementById('app')!);
