// Status bar (port of StatusBar.swift): compile state and issue counts on the left, a transient message, then
// engine · distribution · encoding · word/page count · caret position as glass capsules on the right.
import { t, formatDecimal, formatInt } from "../i18n";
import type { Encoding } from "../ipc";
import { engineName } from "../app/commands";
import { settings } from "../app/settings";
import type { CompileState, Workspace } from "../app/workspace";
import { h, setText, toggleClass } from "./dom";
import { icon } from "./icons";
import { showStatistics } from "./statistics";

const ENCODING_NAMES: Record<Encoding, string> = {
  "utf-8": "UTF-8", "utf-8-bom": "UTF-8 BOM", "latin-1": "ISO Latin 1", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE",
};

export type CompileOutcomeKind = "succeeded" | "failed" | "toolError";

/** Filters statusbar live-region speech so explicit builds always speak while typing-triggered builds only speak on transitions. */
export function compileAnnouncement(opts: {
  state: CompileState;
  purpose: "build" | "live" | undefined;
  prevOutcome: CompileOutcomeKind | null;
  summaryText: string;
  countsText: string;
}): string | null {
  const { state, purpose, prevOutcome, summaryText, countsText } = opts;
  if (state.kind === "idle" || state.kind === "compiling") return null;
  if (state.kind === "toolError") {
    return purpose === "build" || prevOutcome !== "toolError" ? (state.message || summaryText) : null;
  }
  if (state.kind === "failed") {
    return purpose === "build" || prevOutcome !== "failed" ? `${summaryText} (${countsText})` : null;
  }
  return purpose === "build" || prevOutcome === "failed" || prevOutcome === "toolError"
    ? `${summaryText} (${countsText})`
    : null;
}

export function createStatusBar(ws: Workspace, opts: { toggleIssues(): void }): { el: HTMLElement; destroy(): void } {
  const stateIcon = h("span", { class: "state-icon" });
  const stateText = h("span");
  const state = h("div", { class: "capsule glass-capsule state" }, stateIcon, stateText);
  const errors = h("span", { class: "num" });
  const warnings = h("span", { class: "num" });
  const errIcon = h("span", { class: "count-icon" }, icon("errorFill", 13));
  const warnIcon = h("span", { class: "count-icon" }, icon("warningFill", 13));
  const counts = h("button", { class: "capsule glass-capsule interactive counts", title: t("Show or hide the Issues panel (⇧⌘M)"), attrs: { "aria-label": t("Issues") } },
    h("span", { class: "pair" }, errIcon, errors), h("span", { class: "pair" }, warnIcon, warnings));
  counts.addEventListener("click", () => opts.toggleIssues());
  const message = h("div", { class: "status-message" });
  const engine = h("div", { class: "capsule glass-capsule dim" });
  const dist = h("div", { class: "capsule glass-capsule dim" });
  const encoding = h("div", { class: "capsule glass-capsule dim", title: t("Text encoding of the current file") });
  const stats = h("button", { class: "capsule glass-capsule interactive dim stats", title: t("Show document statistics"), attrs: { "aria-label": t("Document Statistics") } });
  stats.addEventListener("click", () => showStatistics(ws, stats));
  const cursor = h("div", { class: "capsule glass-capsule dim mono-digits", attrs: { "aria-label": t("Cursor position") } });
  const live = h("div", { class: "sr-only", attrs: { role: "status", "aria-live": "polite", "aria-atomic": "true" } });

  const el = h("footer", { class: "statusbar" }, state, counts, message, live, h("div", { class: "spacer" }), engine, dist, encoding, stats, cursor);

  let announceFrame = 0;
  const announce = (text: string) => {
    if (announceFrame) cancelAnimationFrame(announceFrame);
    live.textContent = "";
    announceFrame = requestAnimationFrame(() => {
      announceFrame = 0;
      live.textContent = text;
    });
  };

  let lastState = "";
  const renderState = (): string => {
    const s = ws.compileState;
    let key: string = s.kind;
    let text: string;
    let ic: string | null = null;
    switch (s.kind) {
      case "compiling": text = t("Compiling…"); break;
      case "succeeded": ic = "checkFill"; text = ws.lastDurationMs !== undefined ? t("Compiled in %@ s", formatDecimal(ws.lastDurationMs / 1000, 1)) : t("Compiled"); break;
      case "failed": ic = "errorFill"; text = t("Compiled with errors"); break;
      case "toolError": ic = "warningFill"; text = t("Cannot compile"); break;
      default: ic = "circleDashed"; text = ws.hasCompiled ? t("Stopped") : t("Ready");
    }
    key += text;
    state.title = s.kind === "toolError" ? s.message : t("Compile status");
    if (key === lastState) return text;
    lastState = key;
    state.dataset.state = s.kind;
    stateIcon.replaceChildren(ic ? icon(ic, 13) : h("span", { class: "spinner tiny" }));
    setText(stateText, text);
    return text;
  };
  const renderCounts = () => {
    setText(errors, formatInt(ws.errorCount));
    setText(warnings, formatInt(ws.warningCount));
    toggleClass(errIcon, "red", ws.errorCount > 0);
    toggleClass(warnIcon, "orange", ws.warningCount > 0);
    counts.setAttribute("aria-valuetext", t("%lld errors, %lld warnings", ws.errorCount, ws.warningCount));
  };
  let lastMessage = "";
  const renderMessage = () => {
    const text = ws.statusMessage ?? "";
    setText(message, text);
    toggleClass(message, "visible", !!text);
    if (text && text !== lastMessage) announce(text);
    lastMessage = text;
  };
  const renderEngine = () => setText(engine, engineName(ws.effectiveEngine));
  const renderDist = () => {
    if (settings.get("useTectonicWasm")) {
      dist.hidden = false;
      setText(dist, "Tectonic WASM");
      dist.title = t("Use Tectonic WASM compiler");
      return;
    }
    dist.hidden = !ws.tex;
    if (ws.tex) { setText(dist, ws.tex.name); dist.title = ws.tex.binDir; }
  };
  const renderEncoding = () => {
    const enc = ws.current ? ws.encodingOf(ws.current) : undefined;
    encoding.hidden = !enc;
    if (enc) setText(encoding, ENCODING_NAMES[enc] ?? enc);
  };
  const renderStats = () => {
    stats.hidden = !ws.mainFile;
    const words = ws.index?.stats.words;
    let text = words === undefined ? t("– words") : words === 1 ? t("%@ word", formatInt(words)) : t("%@ words", formatInt(words));
    if (words !== undefined && ws.pageCount > 0 && ws.pdfPath) text += " · " + (ws.pageCount === 1 ? t("%@ page", formatInt(1)) : t("%@ pages", formatInt(ws.pageCount)));
    setText(stats, text);
  };
  const renderCursor = () => setText(cursor, t("Ln %lld, Col %lld", ws.cursor.line, ws.cursor.column));

  let prevOutcome: CompileOutcomeKind | null = null;
  const offs = [
    ws.events.on("compile", () => {
      const summaryText = renderState();
      const s = ws.compileState;
      if (s.kind === "succeeded" || s.kind === "failed" || s.kind === "toolError") {
        const msg = compileAnnouncement({
          state: s,
          purpose: ws.lastCompilePurpose,
          prevOutcome,
          summaryText,
          countsText: t("%lld errors, %lld warnings", ws.errorCount, ws.warningCount),
        });
        prevOutcome = s.kind;
        if (msg) announce(msg);
      }
    }),
    ws.events.on("diagnostics", renderCounts),
    ws.events.on("status", () => { renderMessage(); renderEncoding(); }),
    ws.events.on(["engine", "main"], () => { renderEngine(); renderStats(); }),
    ws.events.on("tex", renderDist),
    settings.subscribe(renderDist, ["useTectonicWasm"]),
    ws.events.on("tabs", () => { renderEncoding(); renderCursor(); }),
    ws.events.on(["index", "pdf"], renderStats),
    ws.events.on("cursor", renderCursor),
  ];
  renderState(); renderCounts(); renderMessage(); renderEngine(); renderDist(); renderEncoding(); renderStats(); renderCursor();
  return {
    el,
    destroy: () => {
      if (announceFrame) cancelAnimationFrame(announceFrame);
      offs.forEach((f) => f());
    },
  };
}
