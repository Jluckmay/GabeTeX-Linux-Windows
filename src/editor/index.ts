// The LaTeX editor (CodeMirror 6), mirroring Sources/EditorKit. One EditorView; one EditorState per open file
// kept in a cache, so switching files keeps undo history, selection, scroll, diagnostics and snippet state.
// Heavy parts are lazy: Vim mode (@replit/codemirror-vim) loads on first use.
import "./editor.css";
import { Compartment, EditorSelection, EditorState, Facet, Prec, StateEffect, StateField, Text, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import {
  Decoration, EditorView, WidgetType, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap,
  lineNumbers, tooltips, type Command, type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import type { CompletionResponse, Diagnostic } from "../ipc";
import { latex } from "./latex";
import { autoClosers, autoPairInput, backTab, plainTab, smartBackspace, smartDelete, smartEnter, toggleComment, unitOf } from "./editing";
import { cancelSnippet, insertSnippetAt, parseSnippet, snippets } from "./snippet";
import { hasPackageImport, planPackageImport, prepareMathSymbolInsertion } from "./mathContext";
import { completion } from "./completion";
import { closeDiagnosticPopover, diagnostics, setDiagnosticsEffect } from "./diagnostics";
import { flashField, revealLine } from "./reveal";
import { ctrlClick } from "./mouse";
import { editorContextMenu } from "./contextmenu";
import { lineEnding } from "./scan";
import { cmPhrasesPT, isPortuguese } from "./i18n";
import { checkDocument, setSpellEffect, spellField } from "./spellcheck";

export const setDropPosEffect = StateEffect.define<number | null>();

export function clampDropPos(pos: number, docLength: number): number {
  return Math.max(0, Math.min(Math.trunc(pos), docLength));
}

class DropCaretWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "gx-drop-caret";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

export const dropPosField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = tr.docChanged ? deco.map(tr.changes) : deco;
    for (const e of tr.effects) {
      if (e.is(setDropPosEffect)) {
        if (e.value === null) {
          next = Decoration.none;
        } else {
          const pos = clampDropPos(e.value, tr.state.doc.length);
          next = Decoration.set([Decoration.widget({ widget: new DropCaretWidget(), side: 1 }).range(pos)]);
        }
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface EditorSettings {
  fontSize: number;
  vim: boolean;
  lineNumbers: boolean;
  wrap: boolean;
  tabSize: number;
  spellCheckingLanguages?: string[];
  spellCheckingEnabled?: boolean;
  language?: string;
}

export interface EditorOptions {
  onChange(path: string, text: string): void;
  onCursor(path: string, line: number, column: number): void;
  /** Ctrl-click on an `\input`/`\include`/`\includegraphics`/`\bibliography` … argument (raw target text). */
  onOpenInclude(target: string, fromPath: string): void;
  /** Ctrl-click on a `\ref`-family key (or a `\label`). */
  onJumpToLabel(label: string): void;
  /** Show in PDF: Ctrl-click on ordinary text, Ctrl+Shift+J (Mac ⇧⌘J) or Ctrl+Alt+J at the caret. */
  onForwardSync(path: string, line: number, column: number): void;
  complete(path: string, text: string, line: number, column: number): Promise<CompletionResponse | null>;
  settings: EditorSettings;
}

export interface EditorHandle {
  open(path: string, text: string): void;
  close(path: string): void;
  getText(path: string): string | undefined;
  isDirty(path: string): boolean;
  markSaved(path: string, text?: string): void;
  setDiagnostics(path: string, diags: Diagnostic[]): void;
  reveal(path: string, line: number, column?: number, flash?: boolean): void;
  applySettings(s: Partial<EditorSettings>): void;
  focus(): void;
  insertSnippet(snippet: string, opts?: { ensureMath?: boolean; pkg?: string }): void;
  setDropIndicator(coords: { x: number; y: number } | null): boolean;
  insertSnippetAtCoords(coords: { x: number; y: number }, snippet: string, opts?: { ensureMath?: boolean; pkg?: string }): boolean;
  ensurePackage(path: string, pkg: string): boolean;
  destroy(): void;
  // Extras beyond the shared contract (optional for the shell).
  /** Path of the file shown, or null. */
  currentPath(): string | null;
  /** Ctrl+/ */
  toggleComment(): void;
  /** Ctrl+F (find) — the replace field is part of the same panel. */
  openSearch(): void;
  /** Show in PDF at the caret (calls `onForwardSync`). */
  forwardSync(): void;
  /** Opens completion at the caret (Ctrl+Space). */
  complete(): void;
}

const DEFAULTS: EditorSettings = { fontSize: 13, vim: false, lineNumbers: true, wrap: true, tabSize: 2, spellCheckingLanguages: [], language: "system" };

/** The file a state belongs to. */
const pathFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });

interface Entry {
  path: string;
  state: EditorState;
  eol: "\n" | "\r\n" | "\r";
  saved: Text;
  scroll: StateEffect<unknown> | null;
  settingsVersion: number;
  dirtyCache: { doc: Text; saved: Text; dirty: boolean } | null;
}

type VimModule = typeof import("@replit/codemirror-vim");

const normalize = (text: string) => (text.indexOf("\r") < 0 ? text : text.replace(/\r\n?/g, "\n"));
const toText = (text: string) => Text.of(text.split("\n"));

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  let settings: EditorSettings = { ...DEFAULTS, ...opts.settings };
  let settingsVersion = 0;
  const cache = new Map<string, Entry>();
  const pendingDiagnostics = new Map<string, Diagnostic[]>();
  const pendingReveal = new Map<string, { line: number; column?: number; flash: boolean }>();
  let current: Entry | null = null;
  let vimModule: VimModule | null = null;
  let vimLoading: Promise<void> | null = null;
  let destroyed = false;

  // MARK: Settings → extensions

  const vimC = new Compartment(), lineNumbersC = new Compartment(), wrapC = new Compartment();
  const tabC = new Compartment(), spellC = new Compartment();

  const vimExt = (): Extension => (settings.vim && vimModule ? Prec.highest(vimModule.vim({ status: true })) : []);
  const isInsertLike = (view: EditorView) => {
    if (!settings.vim || !vimModule) return true;
    const cm = vimModule.getCM(view) as unknown as { state?: { vim?: { insertMode?: boolean } } } | null;
    return cm?.state?.vim?.insertMode ?? true;
  };
  const selectLines = (view: EditorView, fromLine: number, toLine: number) => {
    const doc = view.state.doc;
    const a = doc.line(Math.min(fromLine, toLine)), b = doc.line(Math.max(fromLine, toLine));
    view.dispatch({ selection: EditorSelection.range(a.from, b.number < doc.lines ? b.to + 1 : b.to), userEvent: "select.pointer" });
  };
  let dragAnchorLine = 0;
  const lineNumbersExt = (): Extension =>
    settings.lineNumbers
      ? lineNumbers({
        domEventHandlers: {
          mousedown(view, block, event) {
            const e = event as MouseEvent;
            if (e.button !== 0) return false;
            const n = view.state.doc.lineAt(block.from).number;
            dragAnchorLine = e.shiftKey ? view.state.doc.lineAt(view.state.selection.main.anchor).number : n;
            selectLines(view, dragAnchorLine, n);
            view.focus();
            const move = (m: MouseEvent) => {
              const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 4, y: m.clientY }, false);
              selectLines(view, dragAnchorLine, view.state.doc.lineAt(pos).number);
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
            e.preventDefault();
            return true;
          },
        },
      })
      : [];
  const tabExt = (): Extension => {
    const size = Math.max(1, Math.min(16, Math.round(settings.tabSize) || 2));
    return [EditorState.tabSize.of(size), indentUnit.of(" ".repeat(size))];
  };
    const spellExt = (): Extension => {
      if (!settings.spellCheckingLanguages || settings.spellCheckingLanguages.length === 0) return [];
      return [
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || !current) return;
          scheduleSpellCheck(u.state);
        }),
      ];
    };
  const settingEffects = () => [
    vimC.reconfigure(vimExt()),
    lineNumbersC.reconfigure(lineNumbersExt()),
    wrapC.reconfigure(settings.wrap ? EditorView.lineWrapping : []),
    tabC.reconfigure(tabExt()),
    spellC.reconfigure(spellExt()),
  ];

  // MARK: Commands

  const forwardSyncAt = (view: EditorView, pos: number) => {
    const path = view.state.facet(pathFacet);
    if (!path) return;
    const line = view.state.doc.lineAt(pos);
    opts.onForwardSync(path, line.number, pos - line.from + 1);
  };
  const forwardSyncCommand: Command = (view) => {
    forwardSyncAt(view, view.state.selection.main.head);
    return true;
  };

  const support = completion({
    request: (view, pos) => {
      const path = view.state.facet(pathFacet);
      if (!path) return Promise.resolve(null);
      const line = view.state.doc.lineAt(pos);
      return opts.complete(path, view.state.doc.toString(), line.number, pos - line.from + 1);
    },
    isInsertLike,
  });

  const editorKeymap = keymap.of([
    { key: "Enter", run: smartEnter },
    { key: "Backspace", run: smartBackspace },
    { key: "Delete", run: smartDelete },
    { key: "Tab", run: (v) => support.tabComplete(v) || plainTab(v), shift: backTab },
    { key: "Escape", run: cancelSnippet },
    { key: "Mod-/", run: toggleComment },
    { key: "Shift-Mod-j", run: forwardSyncCommand },
    { key: "Mod-Alt-j", run: forwardSyncCommand },
  ]);

  // MARK: Change notifications (coalesced to one per frame)

  let pendingChange = false, pendingCursor = false, frame = 0, silent = false;
  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!current) { pendingChange = pendingCursor = false; return; }
    const path = current.path;
    if (pendingChange) {
      pendingChange = false;
      opts.onChange(path, textOf(current));
    }
    if (pendingCursor) {
      pendingCursor = false;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      opts.onCursor(path, line.number, head - line.from + 1);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; flush(); });
  };

  // MARK: Spell checking (debounced, client-side, offline dictionaries)

  let spellTimer = 0;
  const runSpellCheck = async (state: EditorState) => {
    if (destroyed || !current) return;
    if (settings.spellCheckingEnabled === false || !settings.spellCheckingLanguages || settings.spellCheckingLanguages.length === 0) {
      view.dispatch({ effects: setSpellEffect.of([]) });
      return;
    }
    const text = state.doc.toString();
    const languages = settings.spellCheckingLanguages;
    try {
      const issues = await checkDocument(text, languages, new Set());
      if (destroyed || view.state.doc !== state.doc) return;
      view.dispatch({ effects: setSpellEffect.of(issues) });
    } catch {
      if (destroyed || view.state.doc !== state.doc) return;
      // Dictionary load failure: silently disable spell underlines for this session.
      view.dispatch({ effects: setSpellEffect.of([]) });
    }
  };

  const scheduleSpellCheck = (state: EditorState) => {
    clearTimeout(spellTimer);
    spellTimer = window.setTimeout(() => { spellTimer = 0; void runSpellCheck(state); }, 500);
  };

  const base: Extension = [
    support.extension,
    vimC.of(vimExt()),
    history(),
    drawSelection(),
    highlightSpecialChars(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    EditorState.allowMultipleSelections.of(true),
    diagnostics(),
    lineNumbersC.of(lineNumbersExt()),
    latex(),
    snippets(),
    autoClosers,
    autoPairInput,
    flashField,
    dropPosField,
    wrapC.of(settings.wrap ? EditorView.lineWrapping : []),
    tabC.of(tabExt()),
    spellField,
    spellC.of(spellExt()),
    search({ top: true }),
    tooltips({ parent: document.body }),
    Prec.high(editorKeymap),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ctrlClick(() => ({
      openInclude: (target) => current && opts.onOpenInclude(target, current.path),
      jumpToLabel: (label) => opts.onJumpToLabel(label),
      forwardSync: (pos) => forwardSyncAt(view, pos),
    })),
    editorContextMenu(() => ({
      openInclude: (target) => current && opts.onOpenInclude(target, current.path),
      jumpToLabel: (label) => opts.onJumpToLabel(label),
      forwardSync: (pos) => forwardSyncAt(view, pos),
      toggleComment: (v) => { toggleComment(v); },
    })),
    EditorView.updateListener.of((u) => {
      if (silent || !current) return;
      if (u.docChanged) { pendingChange = true; current.dirtyCache = null; }
      if (u.docChanged || u.selectionSet) pendingCursor = true;
      if (pendingChange || pendingCursor) schedule();
    }),
    EditorView.domEventHandlers({
      dragover(event, v) {
        if (!current || v.state.readOnly) return false;
        if (!event.dataTransfer?.types.includes("application/x-gabetex-symbol")) return false;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        const pos = coordsToPos({ x: event.clientX, y: event.clientY });
        v.dispatch({ effects: setDropPosEffect.of(pos) });
        return true;
      },
      dragleave(event, v) {
        if (!event.relatedTarget || !(event.relatedTarget instanceof Node) || !v.dom.contains(event.relatedTarget)) {
          v.dispatch({ effects: setDropPosEffect.of(null) });
        }
        return false;
      },
      drop(event, v) {
        const raw = event.dataTransfer?.getData("application/x-gabetex-symbol");
        if (!raw || !current || v.state.readOnly) return false;
        event.preventDefault();
        const at = coordsToPos({ x: event.clientX, y: event.clientY });
        v.dispatch({ effects: setDropPosEffect.of(null) });
        if (at === null) return false;
        applySnippet(v, raw, at, at, true);
        v.focus();
        return true;
      },
    }),
    EditorView.editorAttributes.of({ class: "gx-editor" }),
    isPortuguese ? EditorState.phrases.of(cmPhrasesPT) : [],
  ];

  const makeState = (path: string, text: string) =>
    EditorState.create({ doc: text, extensions: [pathFacet.of(path), base] });
  const emptyState = () =>
    EditorState.create({ doc: "", extensions: [base, EditorState.readOnly.of(true), EditorView.editable.of(false)] });

  const view = new EditorView({ state: emptyState(), parent });
  view.dom.style.setProperty("--gx-font-size", `${settings.fontSize}px`);

  const coordsToPos = (coords: { x: number; y: number }): number | null => {
    if (!current || view.state.readOnly) return null;
    const rect = view.scrollDOM.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && (
      coords.x < rect.left || coords.x > rect.right || coords.y < rect.top || coords.y > rect.bottom
    )) {
      return null;
    }
    const pos = view.posAtCoords(coords, false);
    if (pos !== null) return clampDropPos(pos, view.state.doc.length);
    const contentRect = view.contentDOM.getBoundingClientRect();
    return coords.y <= contentRect.top ? 0 : view.state.doc.length;
  };

  const applySnippet = (
    v: EditorView,
    snippet: string,
    from: number,
    to: number,
    ensureMath: boolean,
    pkg?: string,
  ) => {
    let curFrom = from;
    let curTo = to;
    if (pkg) {
      const pkgPlan = planPackageImport(v.state.doc.toString(), pkg);
      if (pkgPlan) {
        v.dispatch({ changes: { from: pkgPlan.offset, to: pkgPlan.offset, insert: pkgPlan.text } });
        if (pkgPlan.offset <= curFrom) curFrom += pkgPlan.text.length;
        if (pkgPlan.offset <= curTo) curTo += pkgPlan.text.length;
      }
    }
    if (!ensureMath) {
      insertSnippetAt(v, snippet, curFrom, curTo, unitOf(v.state));
      return;
    }
    const plan = prepareMathSymbolInsertion(v.state.doc.toString(), curFrom, curTo, snippet);
    insertSnippetAt(v, plan.text, plan.from, plan.to, unitOf(v.state));
    if (plan.moveAfterClosingDollar && parseSnippet(plan.text).stops.length === 0) {
      const head = clampDropPos(v.state.selection.main.head + 1, v.state.doc.length);
      v.dispatch({ selection: EditorSelection.cursor(head) });
    }
  };

  // MARK: Cache

  const stateOf = (e: Entry) => (e === current ? view.state : e.state);
  function textOf(e: Entry): string {
    const s = stateOf(e).doc.toString();
    return e.eol === "\n" ? s : s.replace(/\n/g, e.eol);
  }

  /** Applies a transaction to a cached (not shown) state, or to the view when it is shown. */
  function update(e: Entry, spec: TransactionSpec) {
    if (e === current) view.dispatch(spec);
    else e.state = e.state.update(spec).state;
  }

  function show(e: Entry) {
    if (e === current) return;
    flush();
    if (current) {
      current.state = view.state;
      current.scroll = view.scrollSnapshot();
    }
    closeDiagnosticPopover();
    if (e.settingsVersion !== settingsVersion) {
      e.state = e.state.update({ effects: settingEffects() }).state;
      e.settingsVersion = settingsVersion;
    }
    current = e;
    view.setState(e.state);
    if (e.scroll) view.dispatch({ effects: e.scroll });
    pendingCursor = true;
    schedule();
  }

  function applyPending(e: Entry) {
    const d = pendingDiagnostics.get(e.path);
    if (d) {
      pendingDiagnostics.delete(e.path);
      update(e, { effects: setDiagnosticsEffect.of(d) });
    }
    const r = pendingReveal.get(e.path);
    if (r && e === current) {
      pendingReveal.delete(e.path);
      revealLine(view, r.line, r.column, r.flash);
    }
  }

  async function loadVim() {
    if (vimModule || !settings.vim) return;
    vimLoading ??= import("@replit/codemirror-vim").then((m) => {
      vimModule = m;
    });
    await vimLoading;
    if (destroyed || !settings.vim) return;
    settingsVersion++;
    view.dispatch({ effects: vimC.reconfigure(vimExt()) });
    if (current) current.settingsVersion = settingsVersion;
  }
  if (settings.vim) void loadVim();

  // MARK: Handle

  const handle: EditorHandle = {
    open(path, text) {
      const eol = lineEnding(text);
      const norm = normalize(text);
      let e = cache.get(path);
      if (!e) {
        e = {
          path, state: makeState(path, norm), eol, saved: toText(norm), scroll: null, settingsVersion,
          dirtyCache: null,
        };
        cache.set(path, e);
      } else {
        e.eol = eol;
        const doc = stateOf(e).doc;
        if (doc.length !== norm.length || doc.toString() !== norm) {
          // Text changed behind the editor (reload): replace only the differing middle part.
          const old = doc.toString();
          let a = 0;
          const max = Math.min(old.length, norm.length);
          while (a < max && old.charCodeAt(a) === norm.charCodeAt(a)) a++;
          let b = 0;
          while (b < max - a && old.charCodeAt(old.length - 1 - b) === norm.charCodeAt(norm.length - 1 - b)) b++;
          silent = true;
          try {
            update(e, {
              changes: { from: a, to: old.length - b, insert: norm.slice(a, norm.length - b) },
              annotations: Transaction.addToHistory.of(false),
            });
          } finally {
            silent = false;
          }
          e.dirtyCache = null;
        }
      }
      show(e);
      applyPending(e);
    },

    close(path) {
      const e = cache.get(path);
      pendingDiagnostics.delete(path);
      pendingReveal.delete(path);
      if (!e) return;
      if (e === current) {
        flush();
        current = null;
        closeDiagnosticPopover();
        view.setState(emptyState());
      }
      cache.delete(path);
    },

    getText(path) {
      const e = cache.get(path);
      return e ? textOf(e) : undefined;
    },

    isDirty(path) {
      const e = cache.get(path);
      if (!e) return false;
      const doc = stateOf(e).doc;
      const c = e.dirtyCache;
      if (c && c.doc === doc && c.saved === e.saved) return c.dirty;
      const dirty = !doc.eq(e.saved);
      e.dirtyCache = { doc, saved: e.saved, dirty };
      return dirty;
    },

    markSaved(path, text) {
      const e = cache.get(path);
      if (!e) return;
      if (text === undefined) e.saved = stateOf(e).doc;
      else {
        if (/[\r\n]/.test(text)) e.eol = lineEnding(text);
        const norm = normalize(text);
        const doc = stateOf(e).doc;
        e.saved = doc.length === norm.length && doc.toString() === norm ? doc : toText(norm);
      }
      e.dirtyCache = null;
    },

    setDiagnostics(path, diags) {
      const e = cache.get(path);
      if (e) update(e, { effects: setDiagnosticsEffect.of(diags) });
      else pendingDiagnostics.set(path, diags);
    },

    reveal(path, line, column, flash = true) {
      const e = cache.get(path);
      if (!e) {
        pendingReveal.set(path, { line, column, flash });
        return;
      }
      show(e);
      revealLine(view, line, column, flash);
    },

    applySettings(s) {
      settings = { ...settings, ...s };
      settingsVersion++;
      if (s.fontSize !== undefined) view.dom.style.setProperty("--gx-font-size", `${settings.fontSize}px`);
      if (settings.vim && !vimModule) void loadVim();
      view.dispatch({ effects: settingEffects() });
      if (s.spellCheckingEnabled !== undefined || s.spellCheckingLanguages !== undefined) {
        if (settings.spellCheckingEnabled === false) {
          clearTimeout(spellTimer);
          view.dispatch({ effects: setSpellEffect.of([]) });
        } else {
          scheduleSpellCheck(view.state);
        }
      }
      if (current) current.settingsVersion = settingsVersion;
    },

    focus() {
      view.focus();
    },

    insertSnippet(snippet, opts) {
      if (!current || view.state.readOnly) return;
      const sel = view.state.selection.main;
      applySnippet(view, snippet, sel.from, sel.to, Boolean(opts?.ensureMath), opts?.pkg);
      view.focus();
    },

    setDropIndicator(coords) {
      const pos = coords ? coordsToPos(coords) : null;
      view.dispatch({ effects: setDropPosEffect.of(pos) });
      return pos !== null;
    },

    insertSnippetAtCoords(coords, snippet, opts) {
      const pos = coordsToPos(coords);
      view.dispatch({ effects: setDropPosEffect.of(null) });
      if (pos === null) return false;
      applySnippet(view, snippet, pos, pos, Boolean(opts?.ensureMath), opts?.pkg);
      view.focus();
      return true;
    },

    ensurePackage(path, pkg) {
      const e = cache.get(path);
      if (!e) return false;
      const text = stateOf(e).doc.toString();
      if (hasPackageImport(text, pkg)) return true;
      const plan = planPackageImport(text, pkg);
      if (!plan) return false;
      update(e, { changes: { from: plan.offset, to: plan.offset, insert: plan.text } });
      e.dirtyCache = null;
      return true;
    },

    destroy() {
      destroyed = true;
      clearTimeout(spellTimer);
      flush();
      closeDiagnosticPopover();
      view.destroy();
      cache.clear();
      current = null;
    },

    currentPath: () => current?.path ?? null,
    toggleComment: () => { if (current) toggleComment(view); },
    openSearch: () => { if (current) openSearchPanel(view); },
    forwardSync: () => { if (current) forwardSyncCommand(view); },
    complete: () => { if (current) support.startCompletion(view); },
  };
  return handle;
}
