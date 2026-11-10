// Localization. Keys are the Mac app's English source strings (Localizable.strings), so the Brazilian Portuguese
// table converted from the Mac app hits directly. English needs no table: the key is the text.
// Placeholders follow Apple's format: `%@`, `%lld`, `%d`, and positional `%1$@`.

type Table = Record<string, string>;

let table: Table | null = null;
let lang = "en";
const listeners = new Set<() => void>();

/** Registers a callback invoked whenever the active language changes. Returns an unsubscribe function. */
export function onLanguageChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  // Re-translate the live interface first, then let the views rebuild their dynamic parts.
  retranslate();
  for (const cb of listeners) cb();
}

/** Reverse index: every string produced by `t()` is remembered so `retranslate()` can replace it
   when the language changes, reflecting the switch immediately across the whole interface. */
type Entry = { key: string; args: Array<string | number> };
const reverse = new Map<string, Entry[]>();

function register(text: string, key: string, args: Array<string | number>): void {
  let arr = reverse.get(text);
  if (!arr) { arr = []; reverse.set(text, arr); }
  if (!arr.some((e) => e.key === key && e.args.length === args.length && e.args.every((v, i) => v === args[i]))) arr.push({ key, args });
}

/** Translates `key` without recording it (used while re-translating). */
function translateRaw(key: string, ...args: Array<string | number>): string {
  const extra = EXTRA[key];
  const text = platformize(extra ? (lang === "pt-BR" ? extra : key) : table?.[key] ?? key);
  if (args.length === 0 && text.indexOf("%") < 0) return text;
  let next = 0;
  return text.replace(/%(?:(\d+)\$)?(@|lld|ld|d|%)/g, (_m, pos: string | undefined, spec: string) => {
    if (spec === "%") return "%";
    const index = pos ? Number(pos) - 1 : next++;
    const value = args[index];
    if (value === undefined) return "";
    return typeof value === "number" ? formatInt(value) : value;
  });
}

/** Translates `key` and records the produced string so it can be re-translated later. */
export function t(key: string, ...args: Array<string | number>): string {
  const text = translateRaw(key, ...args);
  register(text, key, args);
  return text;
}

/** Elements that hold user content (file names, outline titles, editor and PDF text) must never be
   re-translated, so they are skipped while sweeping the DOM. */
const SKIP = ".cm-editor, .cm-line, .pv-page, .textLayer, .tree-name, .tab-name, .outline-title, .recent-name, .issue-text, .stat-value";

function isSkipped(el: Element): boolean {
  return el.closest(SKIP) !== null || el.hasAttribute("data-i18n-skip");
}

/** Re-translates every UI text node and attribute produced by `t()` (text content, titles,
   aria-labels, placeholders), so a language switch is reflected immediately across the whole
   interface — the same way a theme switch is. */
export function retranslate(): void {
  if (!document.body) return;
  const old = reverse;
  const next = new Map<string, Entry[]>();
  const remember = (text: string, entry: Entry): void => {
    let arr = next.get(text);
    if (!arr) { arr = []; next.set(text, arr); }
    if (!arr.some((e) => e.key === entry.key && e.args.length === entry.args.length && e.args.every((v, i) => v === entry.args[i]))) arr.push(entry);
  };
  const lookup = (text: string): Entry | undefined => {
    const entries = old.get(text);
    if (!entries?.length) return undefined;
    // Prefer the entry whose key is the text itself (the English source string).
    return entries.find((e) => e.key === text) ?? entries[0];
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || isSkipped(parent)) continue;
    const text = node.nodeValue;
    if (!text) continue;
    const entry = lookup(text);
    if (!entry) continue;
    const translated = translateRaw(entry.key, ...entry.args);
    remember(translated, entry);
    if (translated !== text) node.nodeValue = translated;
  }

  for (const el of document.querySelectorAll<HTMLElement>("[title], [aria-label], [placeholder]")) {
    if (isSkipped(el)) continue;
    for (const attr of ["title", "aria-label", "placeholder"] as const) {
      const text = el.getAttribute(attr);
      if (!text) continue;
      const entry = lookup(text);
      if (!entry) continue;
      const translated = translateRaw(entry.key, ...entry.args);
      remember(translated, entry);
      if (translated !== text) el.setAttribute(attr, translated);
    }
  }

  reverse.clear();
  for (const [text, arr] of next) for (const entry of arr) register(text, entry.key, entry.args);
}

/** Picks the language from `navigator.languages` and loads its table (lazy: English loads nothing). */
export async function initI18n(): Promise<void> {
  let tag = "en";
  const list = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  for (const raw of list) {
    const l = raw.toLowerCase();
    if (l.startsWith("pt")) { tag = "pt-BR"; break; }
    if (l.startsWith("en")) break;
  }
  await loadLang(tag);
  document.documentElement.lang = lang;
  notify();
}

/** Forces a specific language tag ("en" or "pt-BR"), loading its table if needed. */
export async function setLanguage(tag: "en" | "pt-BR"): Promise<void> {
  await loadLang(tag);
  document.documentElement.lang = lang;
  notify();
}

/** Loads the table for `tag` and switches language and table together, so no `t()` call ever sees
   a half-applied language. */
async function loadLang(tag: string): Promise<void> {
  let next: Table | null = null;
  let nextLang = "en";
  if (tag === "pt-BR") {
    try {
      next = (await import("./pt-BR.json")).default as Table;
      nextLang = "pt-BR";
    } catch {
      next = null;
      nextLang = "en";
    }
  }
  table = next;
  lang = nextLang;
}

/** The active language tag ("en" or "pt-BR"). */
export const language = (): string => lang;

/**
 * Strings that differ from the Mac app (Linux/Windows wording) with their pt-BR translation. English is the key.
 */
const EXTRA: Record<string, string> = {
  "Cut": "Recortar",
  "Copy": "Copiar",
  "Paste": "Colar",
  "Select All": "Selecionar Tudo",
  "Go to Definition": "Ir para a Definição",
  "Open in Default App": "Abrir no Aplicativo Padrão",
  "Reveal in File Manager": "Mostrar no Gerenciador de Arquivos",
  "Show PDF in File Manager": "Mostrar PDF no Gerenciador de Arquivos",
  "Install TeX Live or MiKTeX to compile documents.": "Instale o TeX Live ou o MiKTeX para compilar documentos.",
  "Get TeX Live": "Obter TeX Live",
  "Get MiKTeX": "Obter MiKTeX",
  "Get TinyTeX": "Obter TinyTeX",
  "Install a TeX distribution to compile documents.": "Instale uma distribuição TeX para compilar documentos.",
  "Or choose a custom TeX folder in Settings.": "Ou escolha uma pasta TeX personalizada nos Ajustes.",
  "Zotero": "Zotero",
  "Zotero status": "Status do Zotero",
  "Connected": "Conectado",
  "Not connected": "Não conectado",
  "Make sure Zotero is running and the local API is enabled.": "Certifique-se de que o Zotero está em execução e a API local está habilitada.",
  "Zotero Web API docs": "Documentação da API Web do Zotero",
  "Collections": "Coleções",
  "No collections found.": "Nenhuma coleção encontrada.",
  "Items": "Itens",
  "No items found.": "Nenhum item encontrado.",
  "Selected items": "Itens selecionados",
  "Export to BibTeX": "Exportar para BibTeX",
  "Save zotero.bib…": "Salvar zotero.bib…",
  "No BibTeX exported yet.": "Nenhum BibTeX exportado ainda.",
  "Export failed": "Exportação falhou",
  "Unknown error": "Erro desconhecido",
  "BibTeX exported": "BibTeX exportado",
  "Copy the BibTeX below and save it as zotero.bib in your project folder.": "Copie o BibTeX abaixo e salve-o como zotero.bib na pasta do seu projeto.",
  "OK": "OK",
  "Connect to Zotero’s local API to browse your library and export citations as BibTeX. Save the .bib file in your project and reference it with \\bibliography{zotero} or \\addbibresource{zotero.bib}.": "Conecte-se à API local do Zotero para navegar pela sua biblioteca e exportar citações como BibTeX. Salve o arquivo .bib na pasta do seu projeto e referencie-o com \\bibliography{zotero} ou \\addbibresource{zotero.bib}.",
  "Refresh": "Atualizar",
  "Edit Label…": "Editar Rótulo…",
  "PDF Only": "Somente PDF",
  "Show the editor again": "Mostrar o editor novamente",
  "Maximize the PDF preview": "Maximizar a pré-visualização do PDF",
  "Folder": "Pasta",
  "The PDF was updated": "O PDF foi atualizado",
  "Saved": "Salvo",
  "Could not reveal the file": "Não foi possível mostrar o arquivo",
  "Language follows the system.": "O idioma acompanha o sistema.",
  "Appearance follows the system (Light or Dark).": "A aparência acompanha o sistema (Claro ou Escuro).",
  "“%@” was reloaded": "“%@” foi recarregado",
  "Installed %@": "%@ instalado",
  "Compile the document first.": "Compile o documento primeiro.",
  "This position was not found in the PDF.": "Esta posição não foi encontrada no PDF.",
  "This position was not found in the source.": "Esta posição não foi encontrada no código-fonte.",
  "Hide Sidebar": "Ocultar Barra Lateral",
  "Show Sidebar": "Mostrar Barra Lateral",
  "Close": "Fechar",
};

const MOD_NAMES: Record<string, string> = { "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⌘": "Ctrl" };
const MOD_ORDER = ["Ctrl", "Alt", "Shift"];
/** Mac shortcut glyphs in prose (“(⇧⌘M)”, “⌘-click”) become Linux/Windows spelling (“(Ctrl+Shift+M)”, “Ctrl-click”). */
export function platformize(text: string): string {
  if (!/[⌃⌥⇧⌘]/.test(text)) return text;
  return text.replace(/([⌃⌥⇧⌘]+)(-click|[^\s)]+)?/g, (_m, mods: string, key: string | undefined) => {
    const names = [...new Set([...mods].map((c) => MOD_NAMES[c] ?? c))].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    if (!key) return names.join("+");
    if (key.startsWith("-")) return names.join("+") + key;
    return [...names, keyName(key)].join("+");
  });
}
const KEY_NAMES: Record<string, string> = { "↩": "Enter", "⌫": "Backspace", "⎋": "Esc", "⇥": "Tab", "↑": "Up", "↓": "Down", "←": "Left", "→": "Right" };
const keyName = (k: string): string => KEY_NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k);

const intFormat = new Map<string, Intl.NumberFormat>();
/** Integer with the locale's grouping (1,234 / 1.234). */
export function formatInt(n: number): string {
  let f = intFormat.get(lang);
  if (!f) { f = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }); intFormat.set(lang, f); }
  return f.format(n);
}

/** A decimal with exactly `digits` fraction digits (0,2 / 0.2). */
export function formatDecimal(n: number, digits = 1): string {
  return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** “a”, “a and b”, “a, b, and c” in the active language. */
export function formatList(items: string[]): string {
  try {
    return new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}
