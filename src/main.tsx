import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// 启动时同步应用主题（在 React 渲染之前，避免首屏闪烁）
import "./store/themeStore";
// 国际化初始化（默认中文，支持英文切换）
import "./i18n";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
