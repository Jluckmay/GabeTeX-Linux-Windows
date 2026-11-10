// Settings (port of SettingsView and its panes): General, Editor, Shortcuts and TeX, shown as a glass sheet with
// a macOS-style pane bar. Changes apply immediately and persist through the settings store.
import * as ipc from "../ipc";
import { t, formatDecimal } from "../i18n";
import { settings, type AppSettingsData, type SyncTrigger } from "../app/settings";
import { ENGINES, commands, CATEGORY_TITLES, type Category } from "../app/commands";
import { shortcuts, comboFromEvent, hasCommandModifier } from "../app/shortcuts";
import { h, setText } from "./dom";
import { icon } from "./icons";
import { showSheet, alertDialog } from "./overlay";
import { onLanguageChange } from "../i18n";

type Pane = "general" | "editor" | "shortcuts" | "tex" | "zotero";
let lastPane: Pane = "general";

type BoolKey = { [K in keyof AppSettingsData]: AppSettingsData[K] extends boolean ? K : never }[keyof AppSettingsData];

function toggleRow(label: string, key: BoolKey): HTMLElement {
  const input = h("input", { class: "switch", checked: settings.get(key), attrs: { type: "checkbox", role: "switch", "aria-label": label } });
  input.addEventListener("change", () => settings.set(key, input.checked));
  return h("label", { class: "set-row" }, h("span", { class: "set-label", text: label }), input);
}

function section(title: string, rows: Array<HTMLElement | null>, footer?: string): HTMLElement {
  return h("div", { class: "set-section" },
    h("div", { class: "set-section-title", text: title }),
    h("div", { class: "set-group" }, rows),
    footer ? h("div", { class: "set-footer", text: footer }) : null);
}

function row(label: string, control: HTMLElement): HTMLElement {
  return h("div", { class: "set-row" }, h("span", { class: "set-label", text: label }), control);
}

/** Custom dropdown styled like the presentation-mode option list (glass popup, rounded items,
   blue highlight). Replaces the native <select> so the dropdown matches the UI visual style. */
function dropdown<T extends string>(label: string, value: T, options: Array<{ value: T; title: string }>, onChange: (v: T) => void): HTMLElement {
  const wrap = h("div", { class: "set-row" }, h("span", { class: "set-label", text: label }));
  // `current` tracks the live selected value so the checkmark in the dropdown menu
  // always reflects the current setting, not the value at render time.
  let current = value;
  const renderTrigger = () => {
    const title = options.find((o) => o.value === current)?.title ?? String(current);
    const span = trigger.querySelector(".gx-dropdown-value");
    if (span) span.textContent = t(title);
  };
  const trigger = h("button", {
    class: "gx-dropdown-trigger",
    attrs: { "aria-label": label, "aria-expanded": "false", role: "combobox" },
  }, h("span", { class: "gx-dropdown-value", text: t(options.find((o) => o.value === current)?.title ?? String(current)) }), h("span", { class: "gx-dropdown-chevron", html: "&#9660;" }));
  wrap.appendChild(trigger);

  let menu: HTMLElement | null = null;
  const setValueText = (v: T) => {
    current = v;
    renderTrigger();
  };
  const close = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("open");
  };
  const open = () => {
    if (menu) return;
    const rect = trigger.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    const minWidth = Math.max(160, rect.width);
    menu = h("div", { class: "gx-dropdown-menu", style: `left:0px; top:0px; min-width:${minWidth}px; visibility:hidden;` });
    for (const o of options) {
      const item = h("button", {
        class: "gx-dropdown-item" + (o.value === current ? " selected" : ""),
        attrs: { role: "menuitemradio", "aria-checked": String(o.value === current), tabindex: "-1" },
      }, h("span", { class: "gx-dropdown-item-label", text: t(o.title) }), o.value === current ? h("span", { class: "gx-dropdown-check", text: "✓" }) : null);
      item.addEventListener("click", () => {
        close();
        setValueText(o.value);
        onChange(o.value);
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const mRect = menu.getBoundingClientRect();
    // Clamp horizontally so the menu never leaves the viewport.
    let left = rect.left;
    if (left + mRect.width > viewportW) left = viewportW - mRect.width - 8;
    if (left < 8) left = 8;
    // Prefer below the trigger; flip above when there is not enough room.
    let top = rect.bottom + 6;
    if (top + mRect.height > viewportH && rect.top - mRect.height - 6 >= 0) top = rect.top - mRect.height - 6;
    if (top < 8) top = 8;
    if (top + mRect.height > viewportH) top = viewportH - mRect.height - 8;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "";
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("open");
    const once = (e: MouseEvent) => { if (!menu || !menu.contains(e.target as Node) && e.target !== trigger) close(); };
    document.addEventListener("mousedown", once, true);
    // one-shot cleanup after click outside handled above; also close on escape
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc, true);
    // remove the mousedown listener once a selection is made
    const sel = () => { document.removeEventListener("mousedown", once, true); };
    menu.addEventListener("click", sel, true);
  };
  trigger.addEventListener("click", (e) => { e.stopPropagation(); menu ? close() : open(); });

  // Re-render the trigger value when the language changes so the selected
  // option is translated along with the rest of the interface.
  onLanguageChange(() => {
    renderTrigger();
    if (menu) close();
  });

  return wrap;
}

/** Opens a file picker to import a dictionary file (.dic/.aff). */
/** Custom multi-select dropdown. Allows selecting multiple options, like spell check languages. */
function multiDropdown<T extends string>(label: string, values: T[], options: Array<{ value: T; title: string }>, onChange: (v: T[]) => void): HTMLElement {
  const wrap = h("div", { class: "set-row" }, h("span", { class: "set-label", text: label }));
  let current = [...values];
  
  const renderTrigger = () => {
    const titles = current.map(v => options.find(o => o.value === v)?.title ?? String(v));
    const display = titles.length === 0 ? t("None") : titles.join(", ");
    const span = trigger.querySelector(".gx-dropdown-value");
    if (span) span.textContent = display;
  };
  
  const trigger = h("button", {
    class: "gx-dropdown-trigger",
    attrs: { "aria-label": label, "aria-expanded": "false", role: "combobox" },
  }, h("span", { class: "gx-dropdown-value", text: current.length === 0 ? t("None") : current.map(v => options.find(o => o.value === v)?.title ?? String(v)).join(", ") }), h("span", { class: "gx-dropdown-chevron", html: "&#9660;" }));
  wrap.appendChild(trigger);

  let menu: HTMLElement | null = null;
  const setValues = (v: T[]) => {
    current = [...v];
    renderTrigger();
  };
  
  const close = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("open");
  };
  
  const open = () => {
    if (menu) return;
    const rect = trigger.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    const minWidth = Math.max(160, rect.width);
    menu = h("div", { class: "gx-dropdown-menu", style: `left:0px; top:0px; min-width:${minWidth}px; visibility:hidden;` });
    
    for (const o of options) {
      const isSelected = current.includes(o.value);
      const item = h("button", {
        class: "gx-dropdown-item" + (isSelected ? " selected" : ""),
        attrs: { role: "menuitemcheckbox", "aria-checked": String(isSelected), tabindex: "-1" },
      }, 
        h("span", { class: "gx-dropdown-item-label", text: t(o.title) }),
        isSelected ? h("span", { class: "gx-dropdown-check", text: "✓" }) : null
      );
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        // Recompute selection from the live `current` array (not the value captured when the
        // menu opened) so deselecting an item and then clicking it again never duplicates it.
        const nowSelected = current.includes(o.value);
        const newValues = nowSelected
          ? current.filter(v => v !== o.value)
          : [...current, o.value];
        setValues(newValues);
        onChange(newValues);
        
        // Update the checkmark to reflect the new state.
        item.classList.toggle("selected", !nowSelected);
        const check = item.querySelector(".gx-dropdown-check");
        if (nowSelected && check) {
          check.remove();
        } else if (!nowSelected && !check) {
          item.appendChild(h("span", { class: "gx-dropdown-check", text: "✓" }));
        }
      });
      menu.appendChild(item);
    }
    
    document.body.appendChild(menu);
    const mRect = menu.getBoundingClientRect();
    let left = rect.left;
    if (left + mRect.width > viewportW) left = viewportW - mRect.width - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 6;
    if (top + mRect.height > viewportH && rect.top - mRect.height - 6 >= 0) top = rect.top - mRect.height - 6;
    if (top < 8) top = 8;
    if (top + mRect.height > viewportH) top = viewportH - mRect.height - 8;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "";
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("open");
    
    const once = (e: MouseEvent) => { if (!menu || !menu.contains(e.target as Node) && e.target !== trigger) close(); };
    document.addEventListener("mousedown", once, true);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc, true);
  };
  
  trigger.addEventListener("click", (e) => { e.stopPropagation(); menu ? close() : open(); });
  
  onLanguageChange(() => {
    renderTrigger();
    if (menu) close();
  });

  return wrap;
}

function slider(label: string, min: number, max: number, step: number, value: number, format: (v: number) => string, onChange: (v: number) => void): HTMLElement {
  const out = h("span", { class: "set-value set-slider-value", text: format(value) });
  const input = h("input", { class: "slider", value: String(value), attrs: { type: "range", min, max, step, "aria-label": label } }) as HTMLInputElement;
  const updateProgress = (v: number) => {
    const range = max - min;
    const pct = range > 0 ? Math.max(0, Math.min(100, ((v - min) / range) * 100)) : 0;
    input.style.setProperty("--slider-pct", `${pct}%`);
  };
  updateProgress(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    updateProgress(v);
    setText(out, format(v));
    onChange(v);
  });
  return row(label, h("span", { class: "set-inline" }, input, out));
}

function stepper(label: string, min: number, max: number, value: number, format: (v: number) => string, onChange: (v: number) => void): HTMLElement {
  let v = value;
  const out = h("span", { class: "set-value", text: format(v) });
  const btn = (delta: number, ic: string) => h("button", { class: "step-btn", attrs: { "aria-label": `${label} ${delta > 0 ? "+" : "−"}` }, on: { click: () => { v = Math.min(max, Math.max(min, v + delta)); setText(out, format(v)); onChange(v); } } }, icon(ic, 11));
  return row(label, h("span", { class: "set-inline" }, out, h("span", { class: "stepper" }, btn(-1, "minus"), btn(1, "plus"))));
}

function formatInterval(seconds: number): string {
  if (seconds < 1) return t("%@ s", formatDecimal(seconds, 1));
  if (seconds < 60) {
    return Number.isInteger(seconds) ? t("%@ s", String(seconds)) : t("%@ s", formatDecimal(seconds, 1));
  }
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  if (sec === 0) return min === 1 ? t("1 minute") : t("%@ minutes", String(min));
  return t("%@ min %@ s", String(min), String(sec));
}

const ACCENT_PRESETS: Array<{ hex: string; title: string }> = [
  { hex: "#0a84ff", title: "Blue" },
  { hex: "#af52de", title: "Purple" },
  { hex: "#ff2d55", title: "Pink" },
  { hex: "#ff3b30", title: "Red" },
  { hex: "#ff9500", title: "Orange" },
  { hex: "#ffcc00", title: "Yellow" },
  { hex: "#34c759", title: "Green" },
  { hex: "#30b0c7", title: "Teal" },
  { hex: "#8e8e93", title: "Graphite" },
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  const n = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  if (Number.isNaN(n)) return [10, 132, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return "#" + [clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  return [h * 360, s, max];
}

function hsvToRgb(hDeg: number, s: number, v: number): [number, number, number] {
  const h = ((hDeg % 360) + 360) % 360 / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function accentColorRow(): HTMLElement {
  let currentColor = (settings.get("accentColor") || "#0a84ff").toLowerCase();
  const wrap = h("div", { class: "set-row accent-row" });
  const label = h("span", { class: "set-label", text: t("Accent Color") });

  const container = h("div", { class: "accent-picker-row" });
  const swatchElements: HTMLElement[] = [];
  let syncPopover: ((hex: string) => void) | null = null;

  const isPreset = (color: string) => ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === color.toLowerCase());

  const updateSelection = (newColor: string, fromPopover = false) => {
    currentColor = newColor.toLowerCase();
    hexInput.value = currentColor.toUpperCase();
    const matchesPreset = isPreset(currentColor);
    customBtn.classList.toggle("selected", !matchesPreset);
    customTriggerBtn.classList.toggle("selected", !matchesPreset);

    swatchElements.forEach((el) => {
      const isSelected = el.getAttribute("data-color") === currentColor;
      el.classList.toggle("selected", isSelected);
      el.setAttribute("aria-checked", String(isSelected));
      el.textContent = "";
      if (isSelected) {
        el.appendChild(h("span", { class: "accent-swatch-check", text: "✓" }));
      }
    });
    if (!fromPopover && syncPopover) {
      syncPopover(currentColor);
    }
    settings.set("accentColor", currentColor);
  };

  // Swatches
  ACCENT_PRESETS.forEach((preset) => {
    const isSelected = preset.hex.toLowerCase() === currentColor;
    const swatch = h("button", {
      class: "accent-swatch" + (isSelected ? " selected" : ""),
      style: `background-color: ${preset.hex};`,
      title: t(preset.title),
      attrs: {
        type: "button",
        role: "radio",
        "aria-label": t(preset.title),
        "aria-checked": String(isSelected),
        "data-color": preset.hex.toLowerCase(),
      },
    }, isSelected ? h("span", { class: "accent-swatch-check", text: "✓" }) : null);

    swatch.addEventListener("click", () => updateSelection(preset.hex));
    swatchElements.push(swatch);
    container.appendChild(swatch);
  });

  // Custom glass color picker popover (triggered by rainbow button)
  const matchesPreset = isPreset(currentColor);
  const customTriggerBtn = h("button", {
    type: "button",
    class: "accent-custom-btn" + (!matchesPreset ? " selected" : ""),
    attrs: { "aria-label": t("Custom color"), "aria-haspopup": "dialog", "aria-expanded": "false" },
  });
  const customBtn = h("div", {
    class: "accent-custom-wrap" + (!matchesPreset ? " selected" : ""),
    title: t("Custom color"),
  }, customTriggerBtn);
  container.appendChild(customBtn);

  let popover: HTMLElement | null = null;
  let cleanupPopover: (() => void) | null = null;

  const closePopover = () => {
    if (cleanupPopover) {
      cleanupPopover();
      cleanupPopover = null;
    }
    if (popover) {
      popover.remove();
      popover = null;
    }
    syncPopover = null;
    customTriggerBtn.setAttribute("aria-expanded", "false");
  };

  const openPopover = () => {
    if (popover) {
      closePopover();
      return;
    }

    let [rVal, gVal, bVal] = hexToRgb(currentColor);
    let [hVal, sVal, vVal] = rgbToHsv(rVal, gVal, bVal);

    const svArea = h("div", { class: "gx-cp-sv" });
    const svWhite = h("div", { class: "gx-cp-sv-white" });
    const svBlack = h("div", { class: "gx-cp-sv-black" });
    const svThumb = h("div", { class: "gx-cp-sv-thumb" });
    svArea.append(svWhite, svBlack, svThumb);

    const eyeBtn = h("button", {
      type: "button",
      class: "gx-cp-eyedropper",
      title: t("Custom color"),
      attrs: { "aria-label": t("Custom color") },
    });
    eyeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>`;
    if (!("EyeDropper" in window)) {
      eyeBtn.style.display = "none";
    } else {
      eyeBtn.addEventListener("click", async () => {
        try {
          const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
          const result = await new Dropper().open();
          if (result && result.sRGBHex) {
            updateSelection(result.sRGBHex, false);
          }
        } catch {
          // User cancelled eyedropper
        }
      });
    }

    const previewSwatch = h("div", { class: "gx-cp-preview" });
    const hueSlider = h("input", {
      class: "gx-cp-hue",
      value: String(Math.round(hVal)),
      attrs: { type: "range", min: "0", max: "360", step: "1", "aria-label": "Hue" },
    }) as HTMLInputElement;

    const controlsRow = h("div", { class: "gx-cp-controls" }, eyeBtn, previewSwatch, hueSlider);

    const makeChannelInput = (labelText: string, initial: number, onChannel: (val: number) => void) => {
      const inp = h("input", {
        class: "gx-cp-channel-input",
        value: String(initial),
        attrs: { type: "number", min: "0", max: "255", "aria-label": labelText },
      }) as HTMLInputElement;
      inp.addEventListener("input", () => {
        const parsed = parseInt(inp.value, 10);
        if (!Number.isNaN(parsed)) {
          onChannel(Math.max(0, Math.min(255, parsed)));
        }
      });
      inp.addEventListener("blur", () => {
        const [cr, cg, cb] = hexToRgb(currentColor);
        inp.value = String(labelText === "R" ? cr : labelText === "G" ? cg : cb);
      });
      const col = h("div", { class: "gx-cp-channel-col" },
        inp,
        h("span", { class: "gx-cp-channel-label", text: labelText })
      );
      return { col, inp };
    };

    const rField = makeChannelInput("R", rVal, (v) => {
      rVal = v;
      [hVal, sVal, vVal] = rgbToHsv(rVal, gVal, bVal);
      renderPopoverState(true);
    });
    const gField = makeChannelInput("G", gVal, (v) => {
      gVal = v;
      [hVal, sVal, vVal] = rgbToHsv(rVal, gVal, bVal);
      renderPopoverState(true);
    });
    const bField = makeChannelInput("B", bVal, (v) => {
      bVal = v;
      [hVal, sVal, vVal] = rgbToHsv(rVal, gVal, bVal);
      renderPopoverState(true);
    });

    const rgbRow = h("div", { class: "gx-cp-rgb-row" }, rField.col, gField.col, bField.col);

    const renderPopoverState = (emitChange: boolean) => {
      const [pureR, pureG, pureB] = hsvToRgb(hVal, 1, 1);
      const pureRgb = `rgb(${pureR}, ${pureG}, ${pureB})`;
      svArea.style.backgroundColor = pureRgb;
      hueSlider.style.setProperty("--hue-color", pureRgb);
      svThumb.style.left = `${sVal * 100}%`;
      svThumb.style.top = `${(1 - vVal) * 100}%`;
      const hex = rgbToHex(rVal, gVal, bVal);
      previewSwatch.style.backgroundColor = hex;
      svThumb.style.backgroundColor = hex;
      hueSlider.value = String(Math.round(hVal));
      if (document.activeElement !== rField.inp) rField.inp.value = String(rVal);
      if (document.activeElement !== gField.inp) gField.inp.value = String(gVal);
      if (document.activeElement !== bField.inp) bField.inp.value = String(bVal);
      if (emitChange) {
        updateSelection(hex, true);
      }
    };

    syncPopover = (hex: string) => {
      [rVal, gVal, bVal] = hexToRgb(hex);
      [hVal, sVal, vVal] = rgbToHsv(rVal, gVal, bVal);
      renderPopoverState(false);
    };

    const updateFromSvPointer = (clientX: number, clientY: number) => {
      const rect = svArea.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      sVal = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      vVal = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
      [rVal, gVal, bVal] = hsvToRgb(hVal, sVal, vVal);
      renderPopoverState(true);
    };

    svArea.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      svArea.setPointerCapture(e.pointerId);
      updateFromSvPointer(e.clientX, e.clientY);
      const onMove = (ev: PointerEvent) => updateFromSvPointer(ev.clientX, ev.clientY);
      const onUp = (ev: PointerEvent) => {
        svArea.releasePointerCapture(ev.pointerId);
        svArea.removeEventListener("pointermove", onMove);
        svArea.removeEventListener("pointerup", onUp);
      };
      svArea.addEventListener("pointermove", onMove);
      svArea.addEventListener("pointerup", onUp);
    });

    hueSlider.addEventListener("input", () => {
      hVal = Number(hueSlider.value);
      [rVal, gVal, bVal] = hsvToRgb(hVal, sVal, vVal);
      renderPopoverState(true);
    });

    renderPopoverState(false);

    popover = h("div", {
      class: "gx-color-popover glass-panel",
      style: "visibility: hidden;",
      attrs: { role: "dialog", "aria-label": t("Custom color") },
    }, svArea, controlsRow, rgbRow);

    document.body.appendChild(popover);
    const btnRect = customTriggerBtn.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    if (left + popRect.width > vw - 12) left = vw - popRect.width - 12;
    if (left < 12) left = 12;

    let top = btnRect.top - popRect.height - 10;
    if (top < 12) top = btnRect.bottom + 10;
    if (top + popRect.height > vh - 12) top = Math.max(12, vh - popRect.height - 12);

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.style.visibility = "";
    customTriggerBtn.setAttribute("aria-expanded", "true");

    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!document.body.contains(customTriggerBtn)) {
        closePopover();
        return;
      }
      if (popover && !popover.contains(target) && !customBtn.contains(target)) {
        closePopover();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePopover();
      }
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    cleanupPopover = () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  };

  customTriggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover();
  });

  // Hex text input
  const hexInput = h("input", {
    class: "accent-hex-input",
    value: currentColor.toUpperCase(),
    attrs: {
      type: "text",
      maxlength: "7",
      placeholder: "#0A84FF",
      "aria-label": t("Hex color"),
      spellcheck: "false",
    },
  }) as HTMLInputElement;

  hexInput.addEventListener("input", () => {
    let val = hexInput.value.trim();
    if (!val.startsWith("#")) val = "#" + val;
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      updateSelection(val);
    }
  });

  hexInput.addEventListener("blur", () => {
    hexInput.value = currentColor.toUpperCase();
  });

  container.appendChild(hexInput);

  wrap.append(label, container);
  return wrap;
}

function generalPane(): HTMLElement {
  return h("div", { class: "set-pane" },
    section(t("Compilation"), [
      dropdown(t("Default engine"), settings.get("defaultEngine"), ENGINES.map((e) => ({ value: e.id, title: e.name })), (v) => settings.set("defaultEngine", v)),
      toggleRow(t("Compile while typing"), "liveCompile"),
      slider(t("Wait after typing"), 0.5, 5, 0.5, settings.get("liveDelay"), (v) => t("%@ s", formatDecimal(v, 1)), (v) => settings.set("liveDelay", v)),
      toggleRow(t("Compile when saving"), "compileOnSave"),
    ], t("Live compiling uses a private copy of your project, so unsaved text is checked without touching your files. A “% !TEX program = …” comment in the main file overrides the engine.")),
    section(t("Auto-save"), [
      toggleRow(t("Save automatically"), "autoSave"),
      slider(t("Auto-save interval"), 0.2, 180, 0.2, settings.get("autoSaveInterval"), (v) => formatInterval(v), (v) => settings.set("autoSaveInterval", Math.round(v * 10) / 10)),
    ], t("Automatically saves open files with unsaved changes at regular intervals.")),
    section(t("PDF Preview"), [
      dropdown(t("Jump to source from PDF"), settings.get("pdfSyncTrigger"), [
        { value: "doubleClick", title: "Double-click" },
        { value: "commandClick", title: "Ctrl-click" },
      ], (v) => settings.set("pdfSyncTrigger", v as SyncTrigger)),
      toggleRow(t("Show the PDF position after each build"), "syncAfterBuild"),
      toggleRow(t("Follow cursor in PDF"), "followCursorInPDF"),
    ], t("Clicking text in the PDF takes you to the same word in the source, and ⇧⌘J (Build ▸ Show in PDF) or ⌘-click in the editor shows where a word is in the PDF. “Follow cursor” keeps the PDF scrolled to the cursor once it rests.")),
    section(t("Appearance"), [
      accentColorRow(),
      dropdown(t("Theme"), settings.get("theme"), [
        { value: "system", title: "System" },
        { value: "light", title: "Light" },
        { value: "dark", title: "Dark" },
      ], (v) => settings.set("theme", v)),
      dropdown(t("Language"), settings.get("language"), [
        { value: "system", title: "System" },
        { value: "en", title: "English" },
        { value: "pt-BR", title: "Português (Brasil)" },
      ], (v) => settings.set("language", v)),
    ]),
  );
}

function editorPane(): HTMLElement {
  const preview = h("pre", { class: "font-preview", text: "\\begin{equation}\n  e^{i\\pi} + 1 = 0\n\\end{equation}" });
  const applyPreview = () => {
    preview.style.fontSize = `${settings.get("fontSize")}px`;
    preview.style.lineHeight = String(settings.get("lineHeight"));
  };
  applyPreview();
  return h("div", { class: "set-pane" },
    section(t("Font"), [
      stepper(t("Size"), 8, 40, settings.get("fontSize"), (v) => t("%lld pt", v), (v) => { settings.set("fontSize", v); applyPreview(); }),
      slider(t("Line height"), 1, 2.2, 0.05, settings.get("lineHeight"), (v) => t("%@×", formatDecimal(v, 2)), (v) => { settings.set("lineHeight", v); applyPreview(); }),
      h("div", { class: "set-row preview-row" }, preview),
    ]),
    section(t("Display"), [
      toggleRow(t("Show line numbers"), "showLineNumbers"),
      toggleRow(t("Wrap long lines"), "wrapLines"),
      toggleRow(t("Check spelling while typing"), "spellCheckingEnabled"),
      multiDropdown(t("Spell check languages"), settings.get("spellCheckingLanguages"), [
        { value: "en", title: "English" },
        { value: "pt-BR", title: "Português (Brasil)" },
      ], (v) => settings.set("spellCheckingLanguages", v)),
    ]),
    section(t("Indentation"), [
      stepper(t("Indent width"), 1, 8, settings.get("indentWidth"), (v) => String(v), (v) => settings.set("indentWidth", v)),
    ]),
    section(t("Keyboard"), [toggleRow(t("Vim mode"), "vimMode")], t("Modal editing with motions, operators, text objects and ex commands such as :w and :make.")),
  );
}

function shortcutsPane(): HTMLElement {
  const search = h("input", { class: "search-input", attrs: { type: "search", placeholder: t("Search Shortcuts"), "aria-label": t("Search Shortcuts") } });
  const restore = h("button", { class: "btn glass small", text: t("Restore Defaults…"), title: t("Restore every keyboard shortcut to its default") });
  const list = h("div", { class: "shortcut-list" });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.textContent = "";
    const cats: Category[] = ["file", "edit", "insert", "view", "build", "window", "app"];
    let any = false;
    for (const cat of cats) {
      const cmds = commands().filter((c) => c.category === cat && c.showsInSettings && (!q || c.title.toLowerCase().includes(q) || (shortcuts.combo(c.id) ?? "").toLowerCase().includes(q)));
      if (!cmds.length) continue;
      any = true;
      list.appendChild(section(t(CATEGORY_TITLES[cat]), cmds.map((c) => row(c.title, recorder(c.id, c.title, render)))));
    }
    if (!any) list.appendChild(h("div", { class: "empty-detail", text: t("No matching commands") }));
  };
  search.addEventListener("input", render);
  restore.addEventListener("click", async () => {
    const answer = await alertDialog({
      title: t("Restore all keyboard shortcuts to their defaults?"), message: t("Shortcuts you recorded will be replaced by GabeTeX’s defaults."),
      buttons: [{ title: t("Restore Defaults"), role: "destructive", value: "restore" }, { title: t("Cancel"), role: "cancel", value: "cancel" }],
    });
    if (answer === "restore") { shortcuts.restoreAll(); render(); }
  });
  render();
  return h("div", { class: "set-pane" }, h("div", { class: "shortcut-tools" }, h("div", { class: "search-field glass-capsule" }, icon("magnifier", 13), search), restore), list);
}

/** A click-to-record shortcut field (port of ShortcutRecorderView). */
function recorder(id: string, title: string, rerender: () => void): HTMLElement {
  const customizable = shortcuts.isCustomizable(id);
  const field = h("button", {
    class: "recorder" + (shortcuts.isCustomized(id) ? " custom" : ""), disabled: !customizable,
    title: customizable ? t("Click, then press the new shortcut. ⌫ removes it, Esc cancels.") : t("This shortcut can’t be changed."),
    attrs: { "aria-label": t("Shortcut for %@", title) },
  });
  const show = () => setText(field, shortcuts.combo(id) ?? t("None"));
  show();
  let recording = false;
  const stopRecording = () => { recording = false; field.classList.remove("recording"); show(); document.removeEventListener("keydown", onKey, true); };
  const onKey = async (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { stopRecording(); return; }
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      shortcuts.assign(id, undefined);
      stopRecording();
      rerender();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) { setText(field, [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean).join("+") + "+…"); return; }
    if (!hasCommandModifier(combo)) { setText(field, t("Type Shortcut")); return; }
    stopRecording();
    const outcome = shortcuts.assign(id, combo);
    if (!outcome.ok) {
      const names = outcome.conflicts.map((c) => commands().find((x) => x.id === c)?.title ?? c).join(", ");
      if (outcome.reason === "conflict") {
        const answer = await alertDialog({
          title: t("%@ is already used by %@.", combo, `“${names}”`),
          buttons: [{ title: t("Replace"), role: "default", value: "replace" }, { title: t("Cancel"), role: "cancel", value: "cancel" }],
        });
        if (answer === "replace") shortcuts.assign(id, combo, true);
      } else {
        await alertDialog({ title: t("This shortcut can’t be changed."), message: `${combo} — ${names}` });
      }
    }
    rerender();
  };
  field.addEventListener("click", () => {
    if (recording) { stopRecording(); return; }
    recording = true;
    field.classList.add("recording");
    setText(field, t("Type Shortcut"));
    document.addEventListener("keydown", onKey, true);
  });
  field.addEventListener("blur", () => { if (recording) stopRecording(); });
  const reset = h("button", { class: "icon-btn reset", title: t("Restore Default"), attrs: { "aria-label": t("Restore Default") } }, icon("sync", 12));
  reset.hidden = !shortcuts.isCustomized(id);
  reset.addEventListener("click", () => { shortcuts.restoreDefault(id); rerender(); });
  return h("span", { class: "set-inline" }, reset, field);
}

function texPane(): HTMLElement {
  const programBody = h("div", { class: "set-group" });
  const compilerBody = h("div", { class: "set-group" }, h("div", { class: "set-row" }, h("span", { class: "set-label dim", text: t("Looking for TeX…") })));
  const render = async (d: ipc.TeXDistribution | null) => {
    programBody.textContent = "";
    compilerBody.textContent = "";
    if (!d) {
      compilerBody.append(
        h("div", { class: "set-row" }, h("span", { class: "set-label" }, icon("warningFill", 14, "tint-orange"), " ", t("No TeX distribution was found"))),
        h("div", { class: "set-row" }, h("span", { class: "set-label dim", text: t("Install a TeX distribution to compile documents.") })),
        h("div", { class: "set-row set-inline" },
          h("a", { class: "set-link", href: "https://tug.org/texlive/", target: "_blank", rel: "noopener noreferrer", text: t("Get TeX Live") }),
          h("span", { class: "set-link-sep", text: "  •  " }),
          h("a", { class: "set-link", href: "https://miktex.org/", target: "_blank", rel: "noopener noreferrer", text: t("Get MiKTeX") }),
          h("span", { class: "set-link-sep", text: "  •  " }),
          h("a", { class: "set-link", href: "https://yihui.org/tinytex/", target: "_blank", rel: "noopener noreferrer", text: t("Get TinyTeX") })
        ),
        h("div", { class: "set-row set-inline" },
          h("button", { class: "btn glass small", on: { click: chooseCustomTexFolder }, text: t("Choose TeX Folder…") }),
          h("span", { class: "set-label dim", text: t("or point to an existing installation.") })
        ));
    } else {
      const yes = (ok: boolean) => h("span", { class: "set-value " + (ok ? "ok" : "bad"), text: ok ? t("Available") : t("Not found") });
      compilerBody.append(
        row(t("Compiler"), h("span", { class: "set-value", text: d.name })),
        row(t("Compiler location"), h("span", { class: "set-value mono selectable", text: d.binDir })),
        row("latexmk", yes(d.latexmk)),
        row("tlmgr", yes(d.tlmgr)),
        row("synctex", yes(d.synctex)),
      );
    }
    // Show the app version and location in the Programa section.
    try {
      const v = await ipc.appVersion();
      programBody.append(row(t("Program version"), h("span", { class: "set-value mono", text: v })));
    } catch { /* version unavailable */ }
    try {
      const loc = await ipc.appLocation();
      if (loc) programBody.append(row(t("Program location"), h("span", { class: "set-value mono selectable", text: loc })));
    } catch { /* location unavailable */ }
  };

  async function chooseCustomTexFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: t("Choose the folder that contains pdflatex and latexmk.") }).catch(() => null);
    if (!picked) return;
    try {
      const result = await ipc.setTexPath(picked);
      if (result.found && result.detected) {
        await ipc.detectTex().then(render).catch(() => render(null));
      } else {
        await alertDialog({ title: t("Invalid TeX folder"), message: t("The selected folder does not contain a valid TeX installation.") });
      }
    } catch (e) {
      await alertDialog({ title: t("Error"), message: String(e) });
    }
  }

  const detect = h("button", { class: "btn glass small", title: t("Look for TeX again") }, icon("sync", 13), h("span", { text: t("Detect Again") }));
  const run = () => { ipc.detectTex().then(render).catch(() => render(null)); };
  detect.addEventListener("click", run);
  run();
  return h("div", { class: "set-pane" },
    section(t("Programa"), [programBody]),
    section(t("Compiler"), [compilerBody, h("div", { class: "set-row" }, detect)]));
}

function zoteroPane(): HTMLElement {
  const statusBody = h("div", { class: "set-group" });
  const collectionsBody = h("div", { class: "set-group" });
  const itemsBody = h("div", { class: "set-group" });
  const bibBody = h("div", { class: "set-group" });

  let collections: ipc.ZoteroCollection[] = [];
  let items: ipc.ZoteroItem[] = [];
  let selectedKeys: Set<string> = new Set();
  let bibtexText = "";

  const renderStatus = async (ok: boolean) => {
    statusBody.textContent = "";
    if (ok) {
      statusBody.append(
        h("div", { class: "set-row" },
          h("span", { class: "set-label", text: t("Zotero status") }),
          h("span", { class: "set-value ok", text: t("Connected") })
        ),
        h("div", { class: "set-row" },
          h("span", { class: "set-label dim", text: t("Zotero local API is reachable at http://localhost:23119.") })
        )
      );
    } else {
      statusBody.append(
        h("div", { class: "set-row" },
          h("span", { class: "set-label", text: t("Zotero status") }),
          h("span", { class: "set-value bad", text: t("Not connected") })
        ),
        h("div", { class: "set-row" },
          h("span", { class: "set-label dim", text: t("Make sure Zotero is running and the local API is enabled.") })
        ),
        h("div", { class: "set-row set-inline" },
          h("a", { class: "set-link", href: "https://www.zotero.org/support/kb/web_api/", target: "_blank", rel: "noopener noreferrer", text: t("Zotero Web API docs") })
        )
      );
    }
  };

  const renderCollections = () => {
    collectionsBody.textContent = "";
    if (collections.length === 0) {
      collectionsBody.append(
        h("div", { class: "set-row" },
          h("span", { class: "set-label dim", text: t("No collections found.") })
        )
      );
      return;
    }
    collectionsBody.append(
      h("div", { class: "set-row" }, h("span", { class: "set-label", text: t("Collections") })),
      ...collections.map((c) => {
        const btn = h("button", {
          class: "btn glass small",
          on: { click: async () => {
            try {
              items = await ipc.zoteroItems(c.key);
              selectedKeys.clear();
              renderItems();
            } catch (e) {
              await alertDialog({ title: t("Error"), message: String(e) });
            }
          }},
          text: c.name
        });
        return h("div", { class: "set-row" }, btn);
      })
    );
  };

  const renderItems = () => {
    itemsBody.textContent = "";
    if (items.length === 0) {
      itemsBody.append(
        h("div", { class: "set-row" },
          h("span", { class: "set-label dim", text: t("No items found.") })
        )
      );
      return;
    }
    itemsBody.append(
      h("div", { class: "set-row" }, h("span", { class: "set-label", text: t("Items") })),
      ...items.map((item) => {
        const isSelected = selectedKeys.has(item.key);
        const creators = (item.creators ?? [])
          .filter((c) => c.creatorType === "author")
          .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" "))
          .join(", ");
        const detail = [creators, item.date, item.title].filter(Boolean).join(" — ");
        const checkbox = h("input", {
          attrs: { type: "checkbox", checked: String(isSelected) },
          on: { change: () => {
            if (isSelected) selectedKeys.delete(item.key);
            else selectedKeys.add(item.key);
            renderItems();
          }}
        });
        return h("div", { class: "set-row set-inline" },
          checkbox,
          h("span", { class: "set-value", title: detail, text: item.key + " — " + detail })
        );
      })
    );
  };

  const renderBib = () => {
    bibBody.textContent = "";
    bibBody.append(
      h("div", { class: "set-row" },
        h("span", { class: "set-label", text: t("Selected items") }),
        h("span", { class: "set-value", text: String(selectedKeys.size) })
      ),
      h("div", { class: "set-row" },
        h("button", {
          class: "btn glass small",
          disabled: selectedKeys.size === 0,
          on: { click: async () => {
            try {
              const result = await ipc.zoteroExportBib([...selectedKeys]);
              if (result.ok) {
                bibtexText = result.bibtex;
                renderBib();
              } else {
                await alertDialog({ title: t("Export failed"), message: result.error ?? t("Unknown error") });
              }
            } catch (e) {
              await alertDialog({ title: t("Error"), message: String(e) });
            }
          }},
          text: t("Export to BibTeX")
        })
      ),
      h("div", { class: "set-row" },
        h("button", {
          class: "btn glass small",
          disabled: bibtexText.length === 0,
          on: { click: async () => {
            const { open } = await import("@tauri-apps/plugin-dialog");
            const picked = await open({ directory: true, multiple: false, title: t("Choose project folder to save zotero.bib") }).catch(() => null);
            if (!picked) return;
            try {
              await alertDialog({
                title: t("BibTeX exported"),
                message: t("Copy the BibTeX below and save it as zotero.bib in your project folder."),
                buttons: [{ title: t("OK"), role: "default", value: "ok" }]
              });
            } catch (e) {
              await alertDialog({ title: t("Error"), message: String(e) });
            }
          }},
          text: t("Save zotero.bib…")
        })
      ),
      h("div", { class: "set-row" },
        h("textarea", {
          class: "mono",
          attrs: { readonly: "readonly", rows: "10", cols: "60" },
          text: bibtexText || t("No BibTeX exported yet.")
        })
      )
    );
  };

  const checkStatus = async () => {
    try {
      const ok = await ipc.zoteroStatus();
      await renderStatus(ok);
      if (ok) {
        try {
          collections = await ipc.zoteroCollections();
          renderCollections();
          renderBib();
        } catch (e) {
          await alertDialog({ title: t("Error"), message: String(e) });
        }
      }
    } catch (e) {
      await renderStatus(false);
    }
  };

  const refresh = h("button", { class: "btn glass small", title: t("Refresh"), on: { click: checkStatus } }, icon("sync", 13), h("span", { text: t("Refresh") }));

  return h("div", { class: "set-pane" },
    section(t("Zotero"), [
      h("div", { class: "set-row set-inline" }, refresh),
      statusBody,
      collectionsBody,
      itemsBody,
      bibBody
    ], t("Connect to Zotero’s local API to browse your library and export citations as BibTeX. Save the .bib file in your project and reference it with \\bibliography{zotero} or \\addbibresource{zotero.bib}.")));
}

/** Opens Settings on `pane` (default: the last one shown). */
export function openSettings(pane?: string): void {
  let active: Pane = (["general", "editor", "shortcuts", "tex", "zotero"] as const).find((p) => p === pane) ?? lastPane;
  const content = h("div", { class: "set-content" });
  const bar = h("div", { class: "set-bar", attrs: { role: "tablist" } });
  const panes: Array<{ id: Pane; title: string; icon: string }> = [
    { id: "general", title: t("General"), icon: "gear" },
    { id: "editor", title: t("Editor"), icon: "cursorText" },
    { id: "shortcuts", title: t("Shortcuts"), icon: "keyboard" },
    { id: "tex", title: t("TeX"), icon: "function" },
    { id: "zotero", title: t("Zotero"), icon: "book" },
  ];
  const title = h("div", { class: "set-title" });
  const render = () => {
    lastPane = active;
    bar.textContent = "";
    for (const p of panes) {
      const b = h("button", { class: "set-tab" + (p.id === active ? " selected" : ""), attrs: { role: "tab", "aria-selected": String(p.id === active) } }, icon(p.icon, 20), h("span", { text: p.title }));
      b.addEventListener("click", () => { active = p.id; render(); });
      bar.appendChild(b);
    }
    setText(title, panes.find((p) => p.id === active)!.title);
    content.replaceChildren(active === "general" ? generalPane() : active === "editor" ? editorPane() : active === "shortcuts" ? shortcutsPane() : active === "tex" ? texPane() : zoteroPane());
  };
  render();
  const close = h("button", { class: "icon-btn set-close", title: t("Close"), attrs: { "aria-label": t("Close") } }, icon("xmark", 13));
  const sheet = showSheet(h("div", { class: "settings" }, h("div", { class: "set-head" }, title, close), bar, content), { class: "settings-sheet", label: t("Settings") });
  close.addEventListener("click", () => sheet.close());
}
