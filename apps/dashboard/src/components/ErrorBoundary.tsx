import { Component, type ReactNode } from 'react';
import { ErrorBox } from './ui';

/** Keeps the shell (sidebar, header) usable when a single page throws while rendering. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (this.state.error) return <ErrorBox error={new Error(`This page failed to render: ${this.state.error.message}`)} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
