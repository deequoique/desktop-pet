import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './control-panel.css';
import { installControlGlobalDiagnostics, normalizeDiagnosticError, recordControlDiagnostic } from './diagnostics';
installControlGlobalDiagnostics();
class ControlErrorBoundary extends Component {
    constructor() {
        super(...arguments);
        this.state = { failed: false };
    }
    static getDerivedStateFromError() {
        return { failed: true };
    }
    componentDidCatch(error, info) {
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
            return (_jsx("main", { className: "page", children: _jsxs("section", { className: "card settings-section", children: [_jsx("h1", { children: "\u63A7\u5236\u9762\u677F\u9047\u5230\u9519\u8BEF" }), _jsx("p", { children: "\u9519\u8BEF\u4EE3\u7801\uFF1Aapp_control_react_render_failed\u3002\u8BCA\u65AD\u5DF2\u81EA\u52A8\u4FDD\u5B58\u5728\u672C\u673A\u3002" }), _jsx("button", { className: "primary-button", onClick: () => window.location.reload(), children: "\u91CD\u65B0\u52A0\u8F7D" })] }) }));
        }
        return this.props.children;
    }
}
const root = document.getElementById('root');
createRoot(root).render(_jsx(React.StrictMode, { children: _jsx(ControlErrorBoundary, { children: _jsx(App, {}) }) }));
