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

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
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

  let grad1: string;
  let grad2: string;
  if (raw === "0a84ff" || raw === "007aff") {
    grad1 = "#5b8df0";
    grad2 = "#2f3fa8";
  } else {
    const [h, s, l] = rgbToHsl(r, g, b);
    const [topR, topG, topB] = hslToRgb(h, Math.min(1, s * 0.95), Math.min(0.72, l + 0.12));
    const [botR, botG, botB] = hslToRgb(h, Math.min(1, s * 1.05), Math.max(0.18, l - 0.22));
    grad1 = `rgb(${topR}, ${topG}, ${topB})`;
    grad2 = `rgb(${botR}, ${botG}, ${botB})`;
  }

  root.style.setProperty("--accent", `#${raw}`);
  root.style.setProperty("--accent-hover", `rgb(${hoverR}, ${hoverG}, ${hoverB})`);
  root.style.setProperty("--accent-press", `rgb(${pressR}, ${pressG}, ${pressB})`);
  root.style.setProperty("--accent-tint", `rgba(${r}, ${g}, ${b}, ${tintAlpha})`);
  root.style.setProperty("--accent-tint-strong", `rgba(${r}, ${g}, ${b}, ${tintStrongAlpha})`);
  root.style.setProperty("--on-accent", onAccent);
  root.style.setProperty("--accent-gradient-1", grad1);
  root.style.setProperty("--accent-gradient-2", grad2);

  document.querySelectorAll<SVGStopElement>("#gtx-g stop").forEach((stop, i) => {
    stop.setAttribute("stop-color", i === 0 ? grad1 : grad2);
  });
}
