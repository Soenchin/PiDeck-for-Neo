import React from "react";
import ReactDOM from "react-dom/client";
import type { AppLogLevel } from "@shared/types";
import { App } from "./App";
import "./styles.css";
import "./file-icons.css";

const BOOT_MIN_MS = 450;
const BOOT_COLOR_MS = 500;
const BOOT_LEAVE_MS = 420;

function writeStartupLog(level: AppLogLevel, message: string, detail?: unknown) {
  window.piDesktop?.app.rendererLog(level, "renderer", message, detail).catch(() => undefined);
}

window.addEventListener("error", (event) => {
  writeStartupLog("error", "Renderer startup uncaught error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error),
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  writeStartupLog("error", "Renderer startup unhandled rejection", {
    reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});

writeStartupLog("info", "Renderer bootstrap started", {
  url: window.location.href,
});

const bootStartedAt = performance.now();
let bootDismissed = false;

function dismissBootSplash() {
  if (bootDismissed) return;
  bootDismissed = true;

  const splash = document.getElementById("boot-splash");
  if (!splash) return;

  const waitMin = Math.max(0, BOOT_MIN_MS - (performance.now() - bootStartedAt));

  window.setTimeout(() => {
    splash.classList.add("is-ready");
    writeStartupLog("info", "Boot splash color transition started");

    window.setTimeout(() => {
      splash.classList.add("is-leaving");
      writeStartupLog("info", "Boot splash leave started");

      window.setTimeout(() => {
        splash.remove();
        writeStartupLog("info", "Boot splash removed");
      }, BOOT_LEAVE_MS);
    }, BOOT_COLOR_MS);
  }, waitMin);
}

// App 在基础数据就绪后派发此事件；preload 缺失时也会派发，避免遮罩永远盖住错误页。
window.addEventListener("neonisch-boot-ready", () => {
  dismissBootSplash();
}, { once: true });

// 兜底：最多 8 秒强制退场，防止初始化卡住导致永远卡在开屏。
window.setTimeout(() => {
  if (!bootDismissed) {
    writeStartupLog("warn", "Boot splash force dismiss after timeout");
    dismissBootSplash();
  }
}, 8000);

const rootElement = document.getElementById("root");
if (!rootElement) {
  writeStartupLog("error", "Renderer root element missing");
  throw new Error("Renderer root element missing");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  writeStartupLog("info", "Renderer React tree mounted");
});
