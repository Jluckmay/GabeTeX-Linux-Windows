import { settings } from "./settings";

export function effectiveTheme(theme: "light" | "dark" | "system"): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: "light" | "dark" | "system"): void {
  const root = document.documentElement;
  root.classList.remove("theme-light", "theme-dark");
  root.classList.add(`theme-${effectiveTheme(theme)}`);
}

export function applyAccentColor(hex: string): void {
  const root = document.documentElement;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return;
  const raw = match[1]!.toLowerCase();
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);

  // Perceived brightness (W3C standard luminance)
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  const onAccent = yiq >= 165 ? "#000000" : "#ffffff";

  // Hover and press states
  const hoverR = Math.max(0, Math.min(255, Math.round(r * 0.9)));
  const hoverG = Math.max(0, Math.min(255, Math.round(g * 0.9)));
  const hoverB = Math.max(0, Math.min(255, Math.round(b * 0.9)));
  const pressR = Math.max(0, Math.min(255, Math.round(r * 0.8)));
  const pressG = Math.max(0, Math.min(255, Math.round(g * 0.8)));
  const pressB = Math.max(0, Math.min(255, Math.round(b * 0.8)));

  const isDark = effectiveTheme(settings.get("theme")) === "dark";
  const tintAlpha = isDark ? 0.22 : 0.16;
  const tintStrongAlpha = isDark ? 0.34 : 0.24;

  root.style.setProperty("--accent", `#${raw}`);
  root.style.setProperty("--accent-hover", `rgb(${hoverR}, ${hoverG}, ${hoverB})`);
  root.style.setProperty("--accent-press", `rgb(${pressR}, ${pressG}, ${pressB})`);
  root.style.setProperty("--accent-tint", `rgba(${r}, ${g}, ${b}, ${tintAlpha})`);
  root.style.setProperty("--accent-tint-strong", `rgba(${r}, ${g}, ${b}, ${tintStrongAlpha})`);
  root.style.setProperty("--on-accent", onAccent);
}
