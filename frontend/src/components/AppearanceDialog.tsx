// Appearance settings (#50): theme mode, accent color, UI scale, row density,
// text size, font family and reduced motion.
//
// A small dialog hosting the runtime theme knobs. Changes preview live (the
// parent's handlers write CSS variables / zoom immediately) and persist via the
// appearance lib, so there is nothing to commit — "Done" only closes.

import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  DEFAULT_FONT_SIZE,
  DEFAULT_SCALE,
  FONT_PRESETS,
  MIN_SCALE,
  MAX_SCALE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  ROW_HEIGHTS,
  applyAccent,
  applyScale,
  saveAccent,
  saveScale,
  type RowDensity,
  type ThemeMode,
} from "../lib/appearance";

const THEME_MODES: { value: ThemeMode; label: string; icon: IconName }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "window" },
];

const DENSITIES: { value: RowDensity; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "normal", label: "Normal" },
  { value: "relaxed", label: "Relaxed" },
];

interface AppearanceDialogProps {
  accent: string;
  scale: number;
  themeMode: ThemeMode;
  density: RowDensity;
  fontSize: number;
  font: string;
  reduceMotion: boolean;
  onAccentChange: (hex: string) => void;
  onScaleChange: (percent: number) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onDensityChange: (density: RowDensity) => void;
  onFontSizeChange: (px: number) => void;
  onFontChange: (stack: string) => void;
  onReduceMotionChange: (on: boolean) => void;
  onClose: () => void;
}

export function AppearanceDialog({
  accent, scale, themeMode, density, fontSize, font, reduceMotion,
  onAccentChange, onScaleChange, onThemeModeChange, onDensityChange,
  onFontSizeChange, onFontChange, onReduceMotionChange, onClose,
}: AppearanceDialogProps) {
  const [localAccent, setLocalAccent] = useState(accent);
  const [localScale, setLocalScale] = useState(scale);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Accent and scale are owned here because they preview on every slider tick /
  // swatch click; the rest go straight to the parent's persisted handlers.
  const pickAccent = (hex: string) => {
    setLocalAccent(hex);
    applyAccent(hex);
    saveAccent(hex);
    onAccentChange(hex);
  };
  const setScale = (n: number) => {
    setLocalScale(n);
    applyScale(n);
    saveScale(n);
    onScaleChange(n);
  };

  return (
    <div className="filter-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="appearance-dialog" role="dialog" aria-modal="true" aria-label="Appearance">
        <div className="fd-header">
          <span className="fd-title">Appearance</span>
          <button className="fd-close" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="appearance-body">
          <div className="appearance-section">
            <div className="appearance-label">Theme</div>
            <div className="appearance-segmented" role="radiogroup" aria-label="Theme">
              {THEME_MODES.map((m) => (
                <button
                  key={m.value}
                  role="radio"
                  aria-checked={themeMode === m.value}
                  className={`appearance-seg${themeMode === m.value ? " active" : ""}`}
                  onClick={() => onThemeModeChange(m.value)}
                >
                  <Icon name={m.icon} size={13} />
                  {m.label}
                </button>
              ))}
            </div>
            {themeMode === "system" && (
              <div className="appearance-hint">Follows your Windows light/dark setting.</div>
            )}
          </div>

          <div className="appearance-section">
            <div className="appearance-label">Accent color</div>
            <div className="accent-swatches">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`accent-swatch${localAccent.toLowerCase() === p.value.toLowerCase() ? " active" : ""}`}
                  style={{ background: p.value }}
                  title={p.name}
                  aria-label={p.name}
                  onClick={() => pickAccent(p.value)}
                />
              ))}
              <label className="accent-custom" title="Custom color">
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(localAccent) ? localAccent : "#0078d4"}
                  onChange={(e) => pickAccent(e.target.value)}
                />
                <Icon name="tag" size={12} />
              </label>
              <button
                className="appearance-reset"
                onClick={() => pickAccent(DEFAULT_ACCENT)}
                disabled={!localAccent}
                title="Use theme default"
              >
                Default
              </button>
            </div>
          </div>

          <div className="appearance-section">
            <div className="appearance-label">Row density</div>
            <div className="appearance-segmented" role="radiogroup" aria-label="Row density">
              {DENSITIES.map((d) => (
                <button
                  key={d.value}
                  role="radio"
                  aria-checked={density === d.value}
                  className={`appearance-seg${density === d.value ? " active" : ""}`}
                  onClick={() => onDensityChange(d.value)}
                  title={`${ROW_HEIGHTS[d.value]}px rows`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="appearance-section">
            <div className="appearance-label">Font</div>
            <select
              className="appearance-select"
              value={font}
              onChange={(e) => onFontChange(e.target.value)}
              aria-label="UI font"
            >
              {FONT_PRESETS.map((f) => (
                <option key={f.name} value={f.value}>{f.name}</option>
              ))}
            </select>
          </div>

          <div className="appearance-section">
            <div className="appearance-label">Text size: {fontSize}px</div>
            <div className="appearance-slider-row">
              <input
                className="appearance-slider"
                type="range"
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                step={1}
                value={fontSize}
                onChange={(e) => onFontSizeChange(parseInt(e.target.value, 10))}
                aria-label="Text size"
              />
              <button
                className="appearance-reset"
                onClick={() => onFontSizeChange(DEFAULT_FONT_SIZE)}
                disabled={fontSize === DEFAULT_FONT_SIZE}
                title="Reset text size"
              >
                Reset
              </button>
            </div>
            <div className="appearance-hint">
              Sizes the file list and body text. Use UI scale to resize everything.
            </div>
          </div>

          <div className="appearance-section">
            <div className="appearance-label">UI scale: {localScale}%</div>
            <div className="appearance-slider-row">
              <input
                className="appearance-slider"
                type="range"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={5}
                value={localScale}
                onChange={(e) => setScale(parseInt(e.target.value, 10))}
                aria-label="UI scale"
              />
              <button
                className="appearance-reset"
                onClick={() => setScale(DEFAULT_SCALE)}
                disabled={localScale === DEFAULT_SCALE}
                title="Reset scale"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="appearance-section">
            <label className="appearance-check">
              <input
                type="checkbox"
                checked={reduceMotion}
                onChange={(e) => onReduceMotionChange(e.target.checked)}
              />
              Reduce motion
            </label>
            <div className="appearance-hint">
              Turns off panel and dialog animations. Progress indicators keep moving.
            </div>
          </div>
        </div>
        <div className="fd-footer">
          <button className="fd-ok primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
