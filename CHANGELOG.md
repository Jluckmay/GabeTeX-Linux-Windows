# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.1.2] — 2026-11-21

### Added
- Categorized **Math Symbols** panel in the left sidebar (`Σ` toggle button / `Ctrl+Alt+3`) with 15 categories (470 symbols across core LaTeX, `amsmath`, `amssymb`, `mathrsfs`, `gensymb`, `mathdots`, `eurosym`, plus a text-mode **Linguistic Symbols** section with PDF-style curly serif quotation marks), search, and live preview footer.
- `\log_{}` base-subscript snippet in **Standard Functions** so the cursor lands directly inside the logarithm base (`_{}`).
- Click-to-insert (with snippet tab stops) and pointer drag-and-drop insertion onto any editor coordinate with a live `.gx-drop-caret` indicator.
- Automatic `\usepackage{...}` preamble import on symbol insertion (recognizing `mathtools`→`amsmath` and `amssymb`→`amsfonts`, and updating `mainFile` when editing preamble-less included `.tex` files without switching tabs).
- Context-aware automatic `$...$` / `\[...\]` delimiter wrapping when inserting outside math mode (`src/editor/mathContext.ts`), with adjacent single-`$` merging for consecutive clicks and text-mode bypass for linguistic symbols.
- Full LaTeX delimiter auto-pairing (`{ }`, `( )`, `[ ]`, `$ $`, `\( \)`, `\[ \]`, and `\begin{env}...\end{env}` auto-close on `}`) and paired `Backspace`/`Delete` deletion (`src/editor/pairEditing.ts`).
- New **Book**, **Report**, and **Poster** project templates (bringing New Project creation to 9 templates in `src-tauri/src/core/data/templates.json`, with `src/ui/newProject.ts` + EN/PT-BR localizations).

### Fixed
- Hardened preamble `\usepackage` name validation (`^[A-Za-z0-9._-]+$`), added symlink rejection in `write_template` during New Project creation, serialized concurrent disk writes when auto-importing packages into `main.tex`, and combined preamble import + symbol insertion into a single atomic Undo step.
- Fixed paired `$`/`$$` deletion when balanced `$$...$$` display equations exist later in the document, skipped `$$` in forward single-`$` search, protected optional/multi-argument command braces (`\usepackage[...]{...}`, `\sqrt[n]{x}`, `\frac{a}{b}`, `\\\cmd{}`) and sized delimiters (`\left(...\right)`), evicted deleted closers cleanly in `autoClosers`, and added trailing command spacing when stepping inside an opening `$`.
- Supported same-line `\documentclass...\begin{document}` and multi-line `\usepackage` preambles, guaranteed drag ghost cleanup on window `blur`, applied custom accent contrast (`var(--on-accent)`) on prominent/active sidebar buttons, and deduplicated/completed `en.json` and `pt-BR.json` Math Symbols strings.

## [1.1.1] — 2026-11-19

### Added
- Embedded **Tectonic WASM** fallback compiler with SHA-256 verification, Beamer support, project-scoped PDF output, PDF export on build, and line-number-preserving local date resolution for `\today`.
- **Zotero 7** local API integration in Settings (`127.0.0.1:23119/api/users/0`, nested `data` envelope decoder) to browse collections/items and save `zotero.bib` directly to disk (with status and documentation link shown immediately on open).
- **Appearance & localization settings**: Light/Dark/System theme modes, custom accent color with dynamic app icon, Brazilian Portuguese (`pt-BR`) UI, configurable auto-save interval, and multi-language spell checking (`en` / `pt-BR`) across section headings and formatted prose.
- **Screen reader accessibility**: per-page PDF landmarks, off-screen text fallback, keyboard/screen-reader-accessible PDF links, and polite live compile/status announcements.
- Integrated TinyTeX installation inside the Windows NSIS installer with UTF-8 log output, desktop/start-menu shortcuts, and final launch option.

### Fixed
- Resolved Linux packaging errors by targeting the Ubuntu 22.04 (`glibc 2.35`) baseline for `.AppImage` and `.deb` artifacts.
- Normalized Windows path separators (`/` vs `\`) across the sidebar, tabs, outline, diagnostics, and file watcher.
- Hardened Content Security Policy (CSP), canonicalized symlink checks in `open_in_default_app`, guarded leading-`-` filenames against CLI flag injection, validated `write_pdf_bytes` and `update_accent_icon` parameters, and fixed `latexmk` rerun and Debian/Ubuntu `tlmgr` recovery.

## [1.0.0]

### Added
- Tauri 2 app for Linux and Windows: Rust TeX core, CodeMirror 6 editor, pdf.js preview, SyncTeX, Beamer presentation mode, English and Brazilian Portuguese.
- Packaging for AppImage, `.deb`, NSIS `.exe` and `.msi`, built by CI.
