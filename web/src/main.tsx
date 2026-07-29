import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './control-panel.css';
import { installControlGlobalDiagnostics, normalizeDiagnosticError, recordControlDiagnostic } from './diagnostics';

installControlGlobalDiagnostics();

class ControlErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    recordControlDiagnostic({
      event: 'app.react-render-failed',
      domain: 'app',
      level: 'fatal',
      errorCode: 'app_control_react_render_failed',
      recoverability: 'fatal',
      context: { componentStack: info.componentStack },
      exception: normalizeDiagnosticError(error),
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="page">
          <section className="card settings-section">
            <h1>控制面板遇到错误</h1>
            <p>错误代码：app_control_react_render_failed。诊断已自动保存在本机。</p>
            <button className="primary-button" onClick={() => window.location.reload()}>重新加载</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root')!;
createRoot(root).render(<React.StrictMode><ControlErrorBoundary><App /></ControlErrorBoundary></React.StrictMode>);
