import { Component, type ComponentChildren } from 'preact';
import { report } from '../../crash-host';

// 错误边界（第九十六轮）。Preact 里画界面（render、生命周期、useEffect）抛的错交给最近的一个边界：
//   - RootGuard：包着整个界面。接到就是整个界面画不出来——交给 crash-host 报成致命的（整页的自救页），自己什么都不画；
//   - Guard：包着一块（弹出面板、抽屉、资源库、弹窗……）。接到只是这一块画不出来——把它关上（onFail），顶上说一句，别的照常用。
//     watch 变了（这一块关上、换了一个）就重新画：一直挂着的那几块（资源库面板、抽屉）下次打开时再试一次，不会一直空着。
// 点击、定时器、Promise 里抛的错不经过这里（window 的 error / unhandledrejection，crash-host.ts）

export class RootGuard extends Component<{ children: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  componentDidCatch(error: unknown) {
    this.setState({ failed: true });
    report('boundary', error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface GuardProps {
  // 这一块叫什么（顶上那一句里写）
  name: string;
  // 这一块画不出来时把它关上
  onFail?: () => void;
  // 这个值变了就重新画
  watch?: unknown;
  children: ComponentChildren;
}

export class Guard extends Component<GuardProps, { failed: boolean; watch: unknown }> {
  state = { failed: false, watch: this.props.watch };
  static getDerivedStateFromProps(props: GuardProps, state: { failed: boolean; watch: unknown }) {
    return props.watch !== state.watch ? { failed: false, watch: props.watch } : null;
  }
  componentDidCatch(error: unknown) {
    this.setState({ failed: true });
    report('part', error, { part: this.props.name });
    // 关上这一块（在这一轮画完之后：现在还在画的半路上）
    const close = this.props.onFail;
    if (close) queueMicrotask(close);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
