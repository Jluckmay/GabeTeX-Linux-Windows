use crate::core::completion::{
    complete_at, BibInfo, CompletionItem as CompletionEngineItem, CompletionResult, Kind, LabelInfo, ProjectSymbols, SymbolsRef,
};
use crate::core::compiler::{self, LaTeXCompiler, Purpose};
use crate::core::distribution;
use crate::core::fileops;
use crate::core::log_parser::ShadowPathMapper;
use crate::core::project_index::{build_project_analysis, build_project_index, parent_dir, standardize, to_native, ProjectOptions};
use crate::core::settings::{self, TextFormat};
use crate::core::synctex::SyncTeX;
use crate::core::watcher::{self, WatchHandle};
use crate::core::{packages, templates};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub files: Vec<FileNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    /// "utf-8" or "latin-1"
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// "error" | "warning" | "info"
    pub severity: String,
    pub message: String,
    pub path: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    /// "latex" | "bibtex" | "chktex" | "reference" | "structure"
    pub source: String,
    /// Multi-line context of a TeX error (the `l.12 ...` lines).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Length in UTF-16 units of the offending span starting at `column`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u32>,
    /// File TeX could not find (e.g. `tikz-cd.sty`); the UI offers a package install for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub level: i32,
    pub title: String,
    pub path: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    pub path: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BibEntry {
    pub key: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub entry_type: Option<String>,
    pub path: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    pub words: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIndex {
    pub outline: Vec<OutlineItem>,
    pub labels: Vec<Label>,
    pub citations: Vec<String>,
    pub bib_keys: Vec<BibEntry>,
    pub includes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_file: Option<String>,
    pub warnings: Vec<Diagnostic>,
    pub stats: ProjectStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub label: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Snippet syntax, e.g. `\\frac{${1:num}}{${2:den}}`.
    pub insert_text: String,
    /// Providing package (`amsmath`...), shown as a badge in the completion list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeXDistribution {
    pub name: String,
    pub bin_dir: String,
    pub latexmk: bool,
    pub tlmgr: bool,
    pub synctex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_path: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub missing_packages: Vec<String>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBox {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InverseResult {
    pub path: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    /// Unix epoch milliseconds.
    pub last_opened: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Payload of the `fs-changed` event (emit with `app.emit("fs-changed", FsChanged { paths })`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChanged {
    pub paths: Vec<String>,
}

/// Unsaved editor buffers: absolute path -> text.
pub type Overrides = HashMap<String, String>;

/// Full answer of `complete`: the items plus the document range they replace.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    /// UTF-16 offset in the document where the replacement starts.
    pub from: usize,
    /// UTF-16 offset where it ends (may lie past the cursor, e.g. over an auto-inserted `}`).
    pub to: usize,
    pub prefix: String,
    /// "command" | "environment" | "endEnvironment" | "label" | "citation" | "package" | "file".
    pub context: String,
    pub in_math: bool,
    pub items: Vec<CompletionItem>,
}

/// Tauri managed state: running file watchers (one per project root) and the shadow path mapper of
/// every PDF a compile produced (needed to translate SyncTeX paths).
#[derive(Default)]
pub struct AppState {
    watchers: Mutex<HashMap<String, WatchHandle>>,
    mappers: Mutex<HashMap<String, ShadowPathMapper>>,
    pub current_icon: Mutex<Option<Vec<u8>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs blocking work off the UI thread.
async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("background task failed: {e}"))?
}

fn dir_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn project_info(root: &Path, root_file: Option<String>) -> ProjectInfo {
    let root_str = root.to_string_lossy().into_owned();
    let root_file = root_file.or_else(|| build_project_index(root, &HashMap::new()).root_file);
    ProjectInfo { name: dir_name(root), files: settings::list_files(&root_str), root: root_str, root_file }
}

#[tauri::command]
pub async fn open_project(path: String) -> CmdResult<ProjectInfo> {
    blocking(move || {
        let p = PathBuf::from(&path);
        if p.is_file() {
            let dir = p.parent().map(Path::to_path_buf).ok_or("The file has no folder.")?;
            Ok(project_info(&dir, Some(path)))
        } else if p.is_dir() {
            Ok(project_info(&p, None))
        } else {
            Err(format!("Not found: {path}"))
        }
    })
    .await
}

#[tauri::command]
pub async fn list_files(root: String) -> CmdResult<Vec<FileNode>> {
    blocking(move || Ok(settings::list_files(&root))).await
}

#[tauri::command]
pub async fn read_file(path: String) -> CmdResult<FileContent> {
    blocking(move || {
        let loaded = settings::read_text_file(Path::new(&path), false)?;
        Ok(FileContent { text: loaded.text, encoding: loaded.format.name().to_string() })
    })
    .await
}

#[tauri::command]
pub async fn write_file(path: String, text: String, encoding: String) -> CmdResult<()> {
    blocking(move || {
        let format = TextFormat::parse(&encoding).ok_or_else(|| format!("Unknown encoding “{encoding}”."))?;
        settings::write_text_file(Path::new(&path), &text, format)
    })
    .await
}

#[tauri::command]
pub async fn create_project(parent_dir: String, name: String, template: String) -> CmdResult<ProjectInfo> {
    blocking(move || {
        let author = settings::load_settings().get("author").and_then(|v| v.as_str()).map(str::to_string);
        let created = templates::create_project(&parent_dir, &name, &template, None, author.as_deref())?;
        Ok(project_info(Path::new(&created.root), Some(created.root_file)))
    })
    .await
}

#[tauri::command]
pub async fn project_index(root: String, overrides: Overrides) -> CmdResult<ProjectIndex> {
    blocking(move || Ok(build_project_index(Path::new(&root), &overrides))).await
}

/// Project symbols (labels, bib entries, custom commands, files) for the completion engine.
fn project_symbols(root: &str, path: &str, text: &str) -> ProjectSymbols {
    let mut overrides = HashMap::new();
    overrides.insert(path.to_string(), text.to_string());
    let options = ProjectOptions { current_file: Some(path.to_string()), ..Default::default() };
    let mut symbols = ProjectSymbols::default();
    let Some(analysis) = build_project_analysis(Path::new(root), &overrides, &options) else { return symbols };
    let model = &analysis.model;
    symbols.labels = model
        .labels
        .iter()
        .map(|l| LabelInfo { key: l.key.clone(), path: to_native(&l.file), line: l.line as u32, context: l.context.clone() })
        .collect();
    symbols.bib_entries = model
        .bib_entries
        .iter()
        .map(|b| BibInfo {
            key: b.key.clone(),
            entry_type: Some(b.entry_type.clone()),
            title: b.title.clone(),
            author: b.author.clone(),
            year: b.year.clone(),
        })
        .collect();
    symbols.custom_commands = model
        .custom_commands
        .iter()
        .map(|c| CompletionEngineItem::new(Kind::Command, &c.label, Some(&c.insert_text), c.detail.as_deref(), None))
        .collect();
    symbols.custom_environments = model.custom_environments.clone();
    // Files relative to the directory of the root document, `/`-separated.
    let base = parent_dir(&model.root_file).to_string();
    let prefix = format!("{}/", base.trim_end_matches('/'));
    fn flatten(nodes: &[FileNode], out: &mut Vec<String>) {
        for n in nodes {
            if n.is_dir {
                flatten(n.children.as_deref().unwrap_or(&[]), out);
            } else {
                out.push(n.path.replace('\\', "/"));
            }
        }
    }
    let mut files = Vec::new();
    flatten(&settings::list_files(root), &mut files);
    symbols.project_files = files
        .into_iter()
        .filter_map(|f| {
            let fold = |s: &str| if cfg!(windows) { s.to_lowercase() } else { s.to_string() };
            if fold(&f).starts_with(&fold(&prefix)) {
                f.get(prefix.len()..).map(str::to_string)
            } else {
                None
            }
        })
        .collect();
    symbols
}

fn complete_blocking(root: &str, path: &str, text: &str, line: u32, column: u32) -> Option<CompletionResult> {
    // A first pass without project symbols tells what is being completed; the (costlier) project
    // analysis only runs for contexts that use it.
    let quick = complete_at(text, line, column, &SymbolsRef::default())?;
    if quick.context == "package" {
        return Some(quick);
    }
    let symbols = project_symbols(root, path, text);
    complete_at(text, line, column, &symbols.as_ref())
}

fn to_ipc_item(item: CompletionEngineItem) -> CompletionItem {
    CompletionItem { label: item.label, kind: item.kind.as_str().to_string(), detail: item.detail, insert_text: item.insert_text, package: item.package }
}

#[tauri::command]
pub async fn completions(root: String, path: String, text: String, line: u32, column: u32) -> CmdResult<Vec<CompletionItem>> {
    blocking(move || {
        Ok(complete_blocking(&root, &path, &text, line, column)
            .map(|r| r.items.into_iter().map(to_ipc_item).collect())
            .unwrap_or_default())
    })
    .await
}

/// Like `completions` but also returns the document range to replace (UTF-16 offsets).
#[tauri::command]
pub async fn complete(root: String, path: String, text: String, line: u32, column: u32) -> CmdResult<Option<CompletionResponse>> {
    blocking(move || {
        Ok(complete_blocking(&root, &path, &text, line, column).map(|r| CompletionResponse {
            from: r.from,
            to: r.to,
            prefix: r.prefix,
            context: r.context,
            in_math: r.in_math,
            items: r.items.into_iter().map(to_ipc_item).collect(),
        }))
    })
    .await
}

#[tauri::command]
pub async fn detect_tex() -> CmdResult<Option<TeXDistribution>> {
    blocking(|| Ok(distribution::detect_cached().map(|d| d.to_ipc()))).await
}

/// Compiles live. A newer compile of the same project cancels the one in flight (the compiler's
/// per-project generation counter), and the superseded call returns a cancelled result.
#[tauri::command]
pub async fn compile(
    state: State<'_, AppState>,
    root: String,
    root_file: String,
    engine: Option<String>,
    overrides: Overrides,
    purpose: Option<String>,
) -> CmdResult<CompileResult> {
    let key_root = root.clone();
    let p = match purpose.as_deref() {
        Some("build") => Purpose::Build,
        _ => Purpose::Live,
    };
    let result = blocking(move || compiler::compile_ipc(&root, &root_file, engine.as_deref(), &overrides, p)).await?;
    if let (Some(pdf), Some(dist)) = (&result.pdf_path, distribution::detect_cached()) {
        lock(&state.mappers).insert(pdf.clone(), LaTeXCompiler::new(dist).path_mapper(&key_root));
    }
    Ok(result)
}

/// Stops the compile in flight of a project (also happens implicitly when a newer one starts).
#[tauri::command]
pub fn cancel_compile(root: String) -> CmdResult<()> {
    compiler::cancel_compile(&root, None);
    Ok(())
}

fn mapper_for(state: &AppState, pdf_path: &str, tex_path: Option<&str>) -> ShadowPathMapper {
    let std_pdf = crate::core::log_parser::lexically_standardized(pdf_path);
    let mappers = lock(&state.mappers);
    if let Some(m) = mappers.get(pdf_path).or_else(|| mappers.get(&std_pdf)) {
        return m.clone();
    }
    for (k, m) in mappers.iter() {
        if k.eq_ignore_ascii_case(pdf_path) || k.eq_ignore_ascii_case(&std_pdf) {
            return m.clone();
        }
    }
    // Unknown PDF (e.g. a previous session): map nothing.
    let dir = tex_path.map(|t| parent_dir(&standardize(t)).to_string()).unwrap_or_default();
    ShadowPathMapper::new(&dir, &dir)
}

#[tauri::command]
pub async fn synctex_forward(
    state: State<'_, AppState>,
    pdf_path: String,
    tex_path: String,
    line: u32,
    column: u32,
) -> CmdResult<Vec<SyncBox>> {
    let mapper = mapper_for(&state, &pdf_path, Some(&tex_path));
    blocking(move || {
        let Some(dist) = distribution::detect_cached() else { return Ok(Vec::new()) };
        Ok(SyncTeX::new(&dist).forward(&pdf_path, &tex_path, line, column, &mapper))
    })
    .await
}

#[tauri::command]
pub async fn synctex_inverse(
    state: State<'_, AppState>,
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> CmdResult<Option<InverseResult>> {
    let mapper = mapper_for(&state, &pdf_path, None);
    blocking(move || {
        let Some(dist) = distribution::detect_cached() else { return Ok(None) };
        Ok(SyncTeX::new(&dist).inverse(&pdf_path, page, x, y, &mapper))
    })
    .await
}

#[tauri::command]
pub async fn install_packages(packages: Vec<String>) -> CmdResult<InstallResult> {
    blocking(move || Ok(packages::install_packages(&packages))).await
}

#[tauri::command]
pub fn watch_project(app: AppHandle, state: State<'_, AppState>, root: String) -> CmdResult<()> {
    let emitter = app.clone();
    let handle = watcher::start(&root, move |paths| {
        let _ = emitter.emit("fs-changed", FsChanged { paths });
    })?;
    // Replacing an existing handle stops the old watcher (dropping a handle stops it).
    lock(&state.watchers).insert(root, handle);
    Ok(())
}

#[tauri::command]
pub fn unwatch_project(state: State<'_, AppState>, root: String) -> CmdResult<()> {
    if let Some(handle) = lock(&state.watchers).remove(&root) {
        handle.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> CmdResult<()> {
    blocking(move || settings::reveal_in_file_manager(&path)).await
}

#[tauri::command]
pub async fn load_settings() -> CmdResult<serde_json::Value> {
    blocking(|| Ok(settings::load_settings())).await
}

#[tauri::command]
pub async fn save_settings(settings: serde_json::Value) -> CmdResult<serde_json::Value> {
    blocking(move || settings::save_settings(settings)).await
}

#[tauri::command]
pub async fn recent_projects() -> CmdResult<Vec<RecentProject>> {
    blocking(|| Ok(settings::recent_projects())).await
}

#[tauri::command]
pub async fn add_recent_project(path: String, name: Option<String>) -> CmdResult<Vec<RecentProject>> {
    blocking(move || settings::add_recent_project(&path, name.as_deref())).await
}

#[tauri::command]
pub async fn set_project_label(path: String, label: Option<String>) -> CmdResult<Vec<RecentProject>> {
    blocking(move || settings::set_project_label(&path, label.as_deref())).await
}

/// Returns the app installation directory so the UI can display it.
#[tauri::command]
pub async fn app_location() -> CmdResult<String> {
    blocking(|| {
        std::env::current_exe()
            .map(|p| p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default())
            .map_err(|e| format!("could not get current exe: {e}"))
    })
    .await
}

/// The bytes of a PDF for the preview, sent raw (no JSON array) so large documents stay cheap to transfer.
#[tauri::command]
pub async fn read_pdf(path: String) -> CmdResult<tauri::ipc::Response> {
    blocking(move || {
        if !path.to_lowercase().ends_with(".pdf") {
            return Err("Only PDF files can be opened by the previewer.".into());
        }
        let meta = std::fs::metadata(&path).map_err(|e| format!("could not read {path}: {e}"))?;
        if !meta.is_file() {
            return Err("Only regular PDF files can be opened.".into());
        }
        if meta.len() > 500 * 1024 * 1024 {
            return Err("The PDF file is too large to display in preview.".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

// ---- file operations (sidebar context menu; see core/fileops.rs) --------------------------------------

#[tauri::command]
pub async fn create_file(dir: String, name: String) -> CmdResult<String> {
    blocking(move || fileops::create_file(&dir, &name)).await
}

#[tauri::command]
pub async fn create_folder(dir: String, name: String) -> CmdResult<String> {
    blocking(move || fileops::create_folder(&dir, &name)).await
}

#[tauri::command]
pub async fn rename_path(path: String, name: String) -> CmdResult<String> {
    blocking(move || fileops::rename(&path, &name)).await
}

#[tauri::command]
pub async fn duplicate_path(path: String) -> CmdResult<String> {
    blocking(move || fileops::duplicate(&path)).await
}

#[tauri::command]
pub async fn move_to_trash(path: String) -> CmdResult<()> {
    blocking(move || fileops::move_to_trash(&path)).await
}

#[tauri::command]
pub async fn open_in_default_app(path: String) -> CmdResult<()> {
    blocking(move || fileops::open_in_default_app(&path)).await
}

/// Mac `cleanAuxiliaryFiles`: cancels the build and drops the shadow workspace. Like the Mac app it never deletes
/// anything inside the project folder (a kept `.bbl` for an arXiv upload is the user's file). Returns 0.
#[tauri::command]
pub async fn clean_auxiliary_files(root: String) -> CmdResult<usize> {
    blocking(move || {
        compiler::cancel_compile(&root, None);
        let shadow = Path::new(&compiler::default_shadow_root()).join(compiler::ShadowWorkspace::identifier(&root));
        compiler::ShadowWorkspace::new(&root, &shadow.to_string_lossy()).remove();
        Ok(0)
    })
    .await
}

#[tauri::command]
pub async fn remove_recent_project(path: String) -> CmdResult<Vec<RecentProject>> {
    blocking(move || settings::remove_recent_project(&path)).await
}

/// Returns the app version from Cargo.toml / tauri.conf.json so the UI can display it.
#[tauri::command]
pub async fn app_version() -> CmdResult<String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

// MARK: open_url (PDF links)

/// Accepts only `http:`, `https:` and `mailto:` URLs without whitespace or control characters.
fn checked_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    let scheme_ok = ["http://", "https://", "mailto:"].iter().any(|s| {
        url.len() > s.len() && url.get(..s.len()).is_some_and(|p| p.eq_ignore_ascii_case(s))
    });
    if !scheme_ok || url.len() > 4096 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Only http, https and mailto links can be opened.".to_string());
    }
    Ok(url)
}

/// Opens a link of the PDF in the system browser / mail client (scheme allowlist, no shell involved).
#[tauri::command]
pub async fn open_url(url: String) -> CmdResult<()> {
    blocking(move || {
        use std::process::{Command, Stdio};
        let url = checked_url(&url)?;
        let attempts: Vec<(&str, Vec<&str>)> = if cfg!(windows) {
            vec![("rundll32", vec!["url.dll,FileProtocolHandler", url])]
        } else if cfg!(target_os = "macos") {
            vec![("open", vec![url])]
        } else {
            vec![("xdg-open", vec![url]), ("gio", vec!["open", url])]
        };
        let mut last = String::new();
        for (program, args) in attempts {
            match Command::new(program).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
                Ok(mut child) => {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Ok(());
                }
                Err(e) => last = format!("Could not run {program}: {e}"),
            }
        }
        Err(last)
    })
    .await
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PngIconEntry {
    pub size: u32,
    pub png_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccentIconPayload {
    pub accent_hex: String,
    pub rgba_32: Vec<u8>,
    pub png_images: Vec<PngIconEntry>,
}

pub fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for &b in s.as_bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        buf = (buf << 6) | (v as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

pub fn create_ico_from_pngs(images: &[(u32, u32, Vec<u8>)]) -> Vec<u8> {
    let mut ico = Vec::new();
    let count = images.len() as u16;

    ico.extend_from_slice(&0u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&count.to_le_bytes());

    let mut offset = 6 + 16 * images.len() as u32;

    for (width, height, data) in images {
        let b_width = if *width >= 256 { 0u8 } else { *width as u8 };
        let b_height = if *height >= 256 { 0u8 } else { *height as u8 };
        ico.push(b_width);
        ico.push(b_height);
        ico.push(0);
        ico.push(0);
        ico.extend_from_slice(&1u16.to_le_bytes());
        ico.extend_from_slice(&32u16.to_le_bytes());
        ico.extend_from_slice(&(data.len() as u32).to_le_bytes());
        ico.extend_from_slice(&offset.to_le_bytes());
        offset += data.len() as u32;
    }

    for (_, _, data) in images {
        ico.extend_from_slice(data);
    }

    ico
}

#[cfg(windows)]
fn update_windows_shortcuts(ico_path: Option<&Path>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let ico_arg = match ico_path {
        Some(p) => format!("'{}'", p.to_string_lossy().replace('\'', "''")),
        None => "''".to_string(),
    };

    let script = format!(
        r#"$ico = {};
$ws = New-Object -ComObject WScript.Shell;
$dirs = @(
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop),
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonDesktop),
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Programs),
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonPrograms),
    [System.IO.Path]::Combine([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ApplicationData), 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
);
foreach ($d in $dirs) {{
    if (-not [string]::IsNullOrEmpty($d) -and (Test-Path $d)) {{
        Get-ChildItem -Path $d -Filter "*gabetex*.lnk" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {{
            try {{
                $s = $ws.CreateShortcut($_.FullName);
                if ([string]::IsNullOrEmpty($ico)) {{
                    $s.IconLocation = "$($s.TargetPath),0";
                }} else {{
                    $s.IconLocation = "$ico,0";
                }}
                $s.Save();
            }} catch {{}}
        }}
    }}
}}"#,
        ico_arg
    );

    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script]);
    cmd.creation_flags(0x08000000);
    let _ = cmd.status();

    unsafe {
        windows_sys::Win32::UI::Shell::SHChangeNotify(
            windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
            windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn update_linux_shortcuts(png_256: Option<&[u8]>) -> Result<(), String> {
    if let Some(png) = png_256 {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            let icon_dir = home.join(".local/share/icons/hicolor/256x256/apps");
            if std::fs::create_dir_all(&icon_dir).is_ok() {
                let _ = std::fs::write(icon_dir.join("gabetex-accent.png"), png);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_accent_icon(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: AccentIconPayload,
) -> CmdResult<()> {
    // 1. Runtime window and taskbar icon update
    if payload.rgba_32.len() == 32 * 32 * 4 {
        let image = tauri::image::Image::new(&payload.rgba_32, 32, 32);
        for window in app.webview_windows().values() {
            let _ = window.set_icon(image.clone());
        }
        let mut icon_lock = lock(&state.current_icon);
        *icon_lock = Some(payload.rgba_32);
    }

    // 2. Persistent shortcut update
    let hex_clean = payload.accent_hex.trim_start_matches('#').to_lowercase();
    let is_default = hex_clean == "0a84ff" || hex_clean == "007aff";

    #[cfg(windows)]
    {
        if is_default {
            let _ = update_windows_shortcuts(None);
        } else if !payload.png_images.is_empty() {
            let mut decoded_images = Vec::new();
            for entry in &payload.png_images {
                if let Some(bytes) = decode_base64(&entry.png_base64) {
                    decoded_images.push((entry.size, entry.size, bytes));
                }
            }
            if !decoded_images.is_empty() {
                let ico_bytes = create_ico_from_pngs(&decoded_images);
                let local_app_data = std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                let icon_dir = local_app_data.join("GabeTeX").join("icons");
                let _ = std::fs::create_dir_all(&icon_dir);
                let ico_path = icon_dir.join(format!("gabetex_accent_{hex_clean}.ico"));
                if std::fs::write(&ico_path, &ico_bytes).is_ok() {
                    let _ = update_windows_shortcuts(Some(&ico_path));
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let png_256 = payload
            .png_images
            .iter()
            .find(|e| e.size == 256)
            .and_then(|e| decode_base64(&e.png_base64));
        let _ = update_linux_shortcuts(png_256.as_deref());
    }

    Ok(())
}

#[cfg(test)]
mod open_url_tests {
    use super::checked_url;

    #[test]
    fn allows_only_web_and_mail() {
        assert!(checked_url("https://example.com/a?b=c&d=e").is_ok());
        assert!(checked_url("HTTP://example.com").is_ok());
        assert!(checked_url("mailto:me@example.com").is_ok());
        assert!(checked_url("file:///etc/passwd").is_err());
        assert!(checked_url("javascript:alert(1)").is_err());
        assert!(checked_url("https://a b").is_err());
        assert!(checked_url("https://").is_err());
        assert!(checked_url("-oProxyCommand=x").is_err());
    }

    #[test]
    fn base64_and_ico_creation() {
        use super::{create_ico_from_pngs, decode_base64};

        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert!(decode_base64("invalid!chars").is_none());

        let fake_png_16 = vec![1, 2, 3, 4];
        let fake_png_32 = vec![5, 6, 7, 8, 9];
        let ico = create_ico_from_pngs(&[
            (16, 16, fake_png_16.clone()),
            (32, 32, fake_png_32.clone()),
        ]);

        assert_eq!(&ico[0..4], &[0, 0, 1, 0]);
        assert_eq!(&ico[4..6], &[2, 0]);

        assert_eq!(ico[6], 16);
        assert_eq!(ico[7], 16);
        assert_eq!(&ico[14..18], &[4, 0, 0, 0]);
        assert_eq!(&ico[18..22], &[38, 0, 0, 0]);

        assert_eq!(ico[22], 32);
        assert_eq!(ico[23], 32);
        assert_eq!(&ico[30..34], &[5, 0, 0, 0]);
        assert_eq!(&ico[34..38], &[42, 0, 0, 0]);

        assert_eq!(&ico[38..42], fake_png_16.as_slice());
        assert_eq!(&ico[42..47], fake_png_32.as_slice());
    }
}
