import { render } from 'preact';
import { disallowScripts } from '../core/script';
import { App } from './ui/App';
import './styles.css';

// 用户写的脚本只在计算 Worker 里跑：主线程上编译脚本一律报错，防止哪里不小心在这里运行了
disallowScripts();

render(<App />, document.getElementById('app')!);
