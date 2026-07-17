import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './control-panel.css';
const root = document.getElementById('root');
createRoot(root).render(_jsx(React.StrictMode, { children: _jsx(App, {}) }));
