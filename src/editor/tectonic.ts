// Tectonic WASM compiler service: fallback LaTeX engine when no native TeX
// distribution (TeX Live, MiKTeX, TinyTeX) is installed on the machine.
// Communicates with tectonic-worker.js via Web Worker messages.
import * as ipc from "../ipc";
import { settings } from "../app/settings";

export type TectonicCompileResult = {
  ok: boolean;
  pdfData?: ArrayBuffer;
  diagnostics: ipc.Diagnostic[];
  missingPackages: string[];
  durationMs: number;
  log?: string;
};

const WORKER_URL = new URL("./tectonic-worker.js", import.meta.url).href;

let worker: Worker | null = null;
let initializing = false;
let initPromise: Promise<void> | null = null;
let ready = false;
let initError: string | null = null;
let pendingCompile: { resolve: (value: TectonicCompileResult) => void; reject: (reason: any) => void } | null = null;
let compileId = 0;

function createWorker(): Worker {
  return new Worker(WORKER_URL, { type: "module" });
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = createWorker();
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "progress") {
        return;
      }
      if (msg.type === "result" || msg.type === "error") {
        const cb = pendingCompile;
        pendingCompile = null;
        if (!cb) return;
        if (msg.type === "result") {
          const diagnostics: ipc.Diagnostic[] = [];
          const mainFile = messageMainFile();
          const logLines = (msg.log || "").split("\n");
          for (const line of logLines) {
            const m = line.match(/^!\s+(.*)$/);
            if (m && !/Font .* not loadable/i.test(m[1]) && !/\\textfont .* is undefined/i.test(m[1])) {
              diagnostics.push({
                severity: "error",
                message: m[1],
                path: mainFile,
                line: 1,
                source: "latex",
                detail: line,
              });
            }
          }
          cb.resolve({
            ok: msg.errors === 0,
            pdfData: msg.pdf as ArrayBuffer,
            diagnostics,
            missingPackages: [],
            durationMs: 0,
            log: msg.log,
          });
        } else {
          cb.reject(new Error(msg.message || "Tectonic compilation failed"));
        }
      }
    };
    worker.onerror = (e) => {
      initError = e.message || "Tectonic worker error";
      ready = false;
      const cb = pendingCompile;
      pendingCompile = null;
      if (cb) cb.reject(new Error(initError));
    };
  }
  return worker;
}

let mainFileOverride: string | null = null;
function messageMainFile(): string {
  return mainFileOverride || "";
}

export function setMainFile(path: string | null): void {
  mainFileOverride = path;
}

export function isTectonicReady(): boolean {
  return ready;
}

export function isTectonicEnabled(): boolean {
  return settings.get("useTectonicWasm") === true;
}

export function setTectonicEnabled(value: boolean): void {
  settings.set("useTectonicWasm", value);
}

export async function initializeTectonic(): Promise<void> {
  if (initPromise) return initPromise;
  if (ready) return;
  initializing = true;
  initPromise = (async () => {
    try {
      ensureWorker();
      await new Promise<void>((resolve, reject) => {
        const id = ++compileId;
        const timer = setTimeout(() => {
          if (pendingCompile) {
            pendingCompile = null;
            reject(new Error("Tectonic initialization timed out"));
          }
        }, 60000);
        pendingCompile = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        (worker as Worker).postMessage({
          type: "compile",
          id,
          files: { "main.tex": "\\documentclass{article}\\begin{document}Hello\\end{document}" },
          mainFile: "main.tex",
        });
      });
      ready = true;
      initError = null;
    } catch (e) {
      initError = String(e);
      ready = false;
      throw e;
    } finally {
      initializing = false;
      initPromise = null; // allow retries after failure
    }
  })();
  return initPromise;
}

export async function compileWithTectonic(
  files: Record<string, string>,
  rootFile: string,
): Promise<TectonicCompileResult> {
  if (!isTectonicEnabled()) {
    return {
      ok: false,
      diagnostics: [],
      missingPackages: [],
      durationMs: 0,
      log: "Tectonic WASM is not enabled.",
    };
  }

  if (!ready && !initializing) {
    try {
      await initializeTectonic();
    } catch (e) {
      return {
        ok: false,
        diagnostics: [],
        missingPackages: [],
        durationMs: 0,
        log: String(e),
      };
    }
  } else if (initializing && initPromise) {
    // Another call is initializing; wait for it to complete
    try {
      await initPromise;
    } catch (e) {
      return {
        ok: false,
        diagnostics: [],
        missingPackages: [],
        durationMs: 0,
        log: String(e),
      };
    }
  }

  if (!ready) {
    return {
      ok: false,
      diagnostics: [],
      missingPackages: [],
      durationMs: 0,
      log: "Tectonic WASM is still initializing.",
    };
  }

  setMainFile(rootFile);

  const start = Date.now();
  return new Promise<TectonicCompileResult>((resolve, reject) => {
    const id = ++compileId;
    let timer: ReturnType<typeof setTimeout>;
    pendingCompile = { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (err) => { clearTimeout(timer); reject(err); } };
    try {
      (worker as Worker).postMessage({
        type: "compile",
        id,
        files,
        mainFile: rootFile,
      });
    } catch (e) {
      pendingCompile = null;
      reject(e);
    }
    timer = setTimeout(() => {
      if (pendingCompile) {
        pendingCompile = null;
        reject(new Error("Tectonic compilation timed out after 5 minutes"));
      }
    }, 300000);
  }).then((result) => {
    result.durationMs = Date.now() - start;
    return result;
  });
}

export function terminateTectonic(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  ready = false;
  initPromise = null;
  initializing = false;
  initError = null;
  pendingCompile = null;
}
