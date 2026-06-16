// Appearance settings (#50): accent color, UI font-size scaling, dark toggle.
//
// A small dialog hosting the runtime theme knobs. Changes preview live (the
// helpers write CSS variables / zoom immediately) and persist via the lib.

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  DEFAULT_SCALE,
  MIN_SCALE,
  MAX_SCALE,
  applyAccent,
  applyScale,
  saveAccent,
  saveScale,
} from "../lib/appearance";

interface AppearanceDialogProps {
  accent: string;
  scale: number;
  darkMode: boolean;
  onAccentChange: (hex: string) => void;
  onScaleChange: (percent: number) => void;
  onToggleDark: () => void;
  onClose: () => void;
}

export function AppearanceDialog({
  accent, scale, darkMode,
  onAccentChange, onScaleChange, onToggleDark, onClose,
}: AppearanceDialogProps) {
  const [localAccent, setLocalAccent] = useState(accent);
  const [localScale, setLocalScale] = useState(scale);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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
            <button className="appearance-theme-btn" onClick={onToggleDark}>
              <Icon name={darkMode ? "moon" : "sun"} size={14} />
              {darkMode ? "Dark" : "Light"} — click to switch
            </button>
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
            <div className="appearance-label">UI scale: {localScale}%</div>
            <input
              className="appearance-slider"
              type="range"
              min={MIN_SCALE}
              max={MAX_SCALE}
              step={5}
              value={localScale}
              onChange={(e) => setScale(parseInt(e.target.value, 10))}
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
        <div className="fd-footer">
          <button className="fd-ok primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
