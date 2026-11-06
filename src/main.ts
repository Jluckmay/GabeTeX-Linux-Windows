// Entry point: localization and settings first (one IPC round-trip each), then the shell. The editor and the PDF
// preview are separate chunks, loaded when a project opens.
import "./styles/main.css";
import { initI18n, setLanguage } from "./i18n";
import { settings } from "./app/settings";
import { App } from "./app/app";
import { windowRole } from "./app/windows";

function effectiveTheme(theme: "light" | "dark" | "system"): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: "light" | "dark" | "system"): void {
  const root = document.documentElement;
  root.classList.remove("theme-light", "theme-dark");
  root.classList.add(`theme-${effectiveTheme(theme)}`);
}

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  // Plain browser (no Tauri): a fake backend for development and visual QA. The condition is a build-time constant,
  // so production builds drop the mock chunk entirely.
  if ((import.meta.env.MODE === "development" || import.meta.env.MODE === "mock") && !("__TAURI_INTERNALS__" in window)) {
    (await import("./mock/ipc-mock")).installMockBackend();
  }
  await Promise.all([initI18n(), settings.load()]);
  settings.syncAcrossWindows();
  // Apply user language override (or system default) before rendering the UI.
  const lang = settings.get("language");
  if (lang !== "system") await setLanguage(lang);
  applyTheme(settings.get("theme"));
  settings.subscribe((key) => {
    if (key === "theme") applyTheme(settings.get("theme"));
    if (key === "language") {
      const lang = settings.get("language");
      if (lang !== "system") void setLanguage(lang);
      else void initI18n(); // re-detect from system
    }
  }, ["theme", "language"]);
  // The window's label says what it shows (src/app/windows.ts): the PDF and presentation windows load only their
  // own chunk; everything else is the app shell (Welcome or a project).
  const role = windowRole();
  if (role === "pdf") await (await import("./ui/pdfWindow")).bootPdfWindow(root);
  else if (role === "present") await (await import("./present/presentation")).bootPresentationWindow(root);
  else if (role === "presenter") await (await import("./present/presentation")).bootPresenterWindow(root);
  else await new App(root).start();
  document.documentElement.classList.add("ready");
  window.addEventListener("beforeunload", () => void settings.flush());
}

  // Initialize custom titlebar window controls
  async function initTitlebarControls(): Promise<void> {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
    
      const minimizeBtn = document.getElementById("tb-minimize");
      const maximizeBtn = document.getElementById("tb-maximize");
      const closeBtn = document.getElementById("tb-close");
    
      minimizeBtn?.addEventListener("click", () => void win.minimize().catch(() => {}));
      maximizeBtn?.addEventListener("click", () => void win.toggleMaximize().catch(() => {}));
      closeBtn?.addEventListener("click", () => void win.close().catch(() => {}));
    
      // Update title from window title
      const titleEl = document.querySelector(".titlebar-title");
      if (titleEl) {
        win.title().then(title => {
          if (title) titleEl.textContent = title;
        }).catch(() => {});
      }
    } catch {
      // Running in browser (development), Tauri not available
    }
  }

  void boot();
  void initTitlebarControls();
