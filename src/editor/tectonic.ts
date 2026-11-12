// Tectonic WASM compiler service: fallback LaTeX engine when no native TeX
// distribution (TeX Live, MiKTeX, TinyTeX) is installed on the machine.
// Communicates with tectonic-worker.js via Web Worker messages.
import * as ipc from "../ipc";
import { settings } from "../app/settings";
import TectonicWorker from "./tectonic-worker.js?worker";

export type TectonicCompileResult = {
  ok: boolean;
  pdfData?: ArrayBuffer;
  diagnostics: ipc.Diagnostic[];
  missingPackages: string[];
  durationMs: number;
  log?: string;
};

const INITIALIZATION_TIMEOUT_MS = 5 * 60_000;
const COMPILATION_TIMEOUT_MS = 5 * 60_000;

let worker: Worker | null = null;
let initializing = false;
let initPromise: Promise<void> | null = null;
let ready = false;
let initError: string | null = null;
let initializationStage = "starting";
let pendingCompile: { id: number; resolve: (value: TectonicCompileResult) => void; reject: (reason: any) => void } | null = null;
let compileId = 0;

function createWorker(): Worker {
  return new TectonicWorker();
}

function terminateWorker(): void {
  const current = worker;
  worker = null;
  ready = false;
  current?.terminate();
}

function ensureWorker(): Worker {
  if (!worker) {
    const current = createWorker();
    worker = current;
    current.onmessage = (e: MessageEvent) => {
      if (worker !== current) return;
      const msg = e.data;
      if (msg.type === "progress") {
        initializationStage = msg.stage || msg.key || initializationStage;
        return;
      }
      if (msg.type === "result" || msg.type === "error") {
        const cb = pendingCompile;
        if (!cb || msg.id !== cb.id) return;
        pendingCompile = null;
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
    current.onerror = (e) => {
      if (worker !== current) return;
      initError = e.message || "Tectonic worker error";
      const cb = pendingCompile;
      pendingCompile = null;
      terminateWorker();
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
  initializationStage = "starting the worker";
  initPromise = (async () => {
    try {
      ensureWorker();
      await new Promise<void>((resolve, reject) => {
        const id = ++compileId;
        const timer = setTimeout(() => {
          const error = new Error(
            `Tectonic initialization timed out after ${INITIALIZATION_TIMEOUT_MS / 1000}s while ${initializationStage}.`,
          );
          const pending = pendingCompile;
          pendingCompile = null;
          terminateWorker();
          if (pending) pending.reject(error);
          else reject(error);
        }, INITIALIZATION_TIMEOUT_MS);
        pendingCompile = {
          id,
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
      initializationStage = ready ? "ready" : "idle";
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
    pendingCompile = { id, resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (err) => { clearTimeout(timer); reject(err); } };
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
        const pending = pendingCompile;
        pendingCompile = null;
        terminateWorker();
        pending.reject(new Error("Tectonic compilation timed out after 5 minutes; the worker was restarted."));
      }
    }, COMPILATION_TIMEOUT_MS);
  }).then((result) => {
    result.durationMs = Date.now() - start;
    return result;
  });
}

export function terminateTectonic(): void {
  terminateWorker();
  initPromise = null;
  initializing = false;
  initError = null;
  pendingCompile = null;
}
