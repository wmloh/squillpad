import { useEffect } from "react";
import type { ChangeEvent, RefObject } from "react";

import {
  AUTOSAVE_INTERVAL_SECONDS,
  APPLICATION_TEXT_SCALE_PERCENT_MAX,
  APPLICATION_TEXT_SCALE_PERCENT_MIN,
  APPLICATION_TEXT_SCALE_PERCENT_STEP,
  KEYBOARD_PAN_SPEED_MULTIPLIER_MAX,
  KEYBOARD_PAN_SPEED_MULTIPLIER_MIN,
  KEYBOARD_PAN_SPEED_MULTIPLIER_STEP,
  LASER_POINTER_DECAY_MAX_SECONDS,
  LASER_POINTER_DECAY_MIN_SECONDS,
  LASER_POINTER_DECAY_STEP_SECONDS,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  MARKDOWN_FONT_SIZE_STEP,
  type AutosaveIntervalSeconds,
  type LaserPointerSettings,
  type MarkdownBoxAppearance,
} from "@squillpad/core-model";
import {
  ANIMATED_MENU_CLOSE,
  CANVAS_TOOLBAR_HEIGHT_MAX,
  CANVAS_TOOLBAR_HEIGHT_MIN,
  finishAnimatedMenu,
  prepareAnimatedMenu,
  prepareAnimatedMenuFromSummary,
  refreshAnimatedMenuOrigin,
  type DrawingPreferences,
} from "@squillpad/ui";

import { SettingsIcon } from "./AppChrome";
import { ToggleSwitch } from "./ToggleSwitch";

const SETTINGS_MENU_GUTTER = 8;
const SETTINGS_MENU_GAP = 6;

export interface AppSettingsProps {
  readonly detailsRef: RefObject<HTMLDetailsElement | null>;
  readonly markdownBoxAppearance: MarkdownBoxAppearance;
  readonly textScalePercent: number;
  readonly laserPointerSettings: LaserPointerSettings;
  readonly keyboardPanSpeedMultiplier: number;
  readonly autosaveIntervalSeconds: AutosaveIntervalSeconds;
  readonly drawingPreferences: DrawingPreferences;
  readonly palmRejection: boolean;
  readonly canvasToolbarHeightDraft: string;
  readonly authenticatedUsername: string | undefined;
  readonly applicationPageBackground: "blank" | "ruled" | "grid";
  readonly hostSession: boolean;
  readonly clientReadOnly: boolean;
  readonly busy: boolean;
  readonly profileSettingsImportRef: RefObject<HTMLInputElement | null>;
  readonly projectSettingsImportRef: RefObject<HTMLInputElement | null>;
  readonly onMarkdownBoxAppearanceChange: (appearance: MarkdownBoxAppearance) => void;
  readonly onTextScalePercentChange: (percent: number) => void;
  readonly onLaserPointerSettingsChange: (settings: LaserPointerSettings) => void;
  readonly onKeyboardPanSpeedMultiplierChange: (multiplier: number) => void;
  readonly onAutosaveIntervalChange: (seconds: AutosaveIntervalSeconds) => void;
  readonly onPenDrawsTouchNavigatesChange: (enabled: boolean) => void;
  readonly onPalmRejectionChange: (enabled: boolean) => void;
  readonly onCanvasToolbarHeightDraftChange: (value: string) => void;
  readonly onCanvasToolbarHeightCommit: () => void;
  readonly onPageBackgroundChange: (background: "blank" | "ruled" | "grid") => void;
  readonly onExportProfileSettings: () => void;
  readonly onImportProfileSettings: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onExportProjectSettings: () => void;
  readonly onImportProjectSettings: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function AppSettings({
  detailsRef,
  markdownBoxAppearance,
  textScalePercent,
  laserPointerSettings,
  keyboardPanSpeedMultiplier,
  autosaveIntervalSeconds,
  drawingPreferences,
  palmRejection,
  canvasToolbarHeightDraft,
  authenticatedUsername,
  applicationPageBackground,
  hostSession,
  clientReadOnly,
  busy,
  profileSettingsImportRef,
  projectSettingsImportRef,
  onMarkdownBoxAppearanceChange,
  onTextScalePercentChange,
  onLaserPointerSettingsChange,
  onKeyboardPanSpeedMultiplierChange,
  onAutosaveIntervalChange,
  onPenDrawsTouchNavigatesChange,
  onPalmRejectionChange,
  onCanvasToolbarHeightDraftChange,
  onCanvasToolbarHeightCommit,
  onPageBackgroundChange,
  onExportProfileSettings,
  onImportProfileSettings,
  onExportProjectSettings,
  onImportProjectSettings,
}: AppSettingsProps) {
  useEffect(() => {
    const repositionSettingsMenu = () => {
      const details = detailsRef.current;
      if (details === null || !details.open) return;
      positionSettingsMenu(details);
      refreshAnimatedMenuOrigin(details);
    };
    window.addEventListener("resize", repositionSettingsMenu);
    window.addEventListener("scroll", repositionSettingsMenu, true);
    window.visualViewport?.addEventListener("resize", repositionSettingsMenu);
    window.visualViewport?.addEventListener("scroll", repositionSettingsMenu);
    return () => {
      window.removeEventListener("resize", repositionSettingsMenu);
      window.removeEventListener("scroll", repositionSettingsMenu, true);
      window.visualViewport?.removeEventListener("resize", repositionSettingsMenu);
      window.visualViewport?.removeEventListener("scroll", repositionSettingsMenu);
    };
  }, [detailsRef]);

  return (
    <details
      ref={detailsRef}
      className="topbar-settings section-settings"
      onToggle={(event) => {
        const details = event.currentTarget;
        if (details.open) positionSettingsMenu(details);
        prepareAnimatedMenu(details);
      }}
      onAnimationEnd={(event) => {
        finishAnimatedMenu(event.currentTarget, event.animationName, event.target);
        if (event.animationName === ANIMATED_MENU_CLOSE && !event.currentTarget.open) {
          event.currentTarget.style.removeProperty("--section-settings-menu-left");
          event.currentTarget.style.removeProperty("--section-settings-menu-top");
          event.currentTarget.style.removeProperty("--section-settings-menu-max-height");
        }
      }}
    >
      <summary
        aria-label="Settings"
        title="Settings"
        onClick={(event) => {
          const details = event.currentTarget.parentElement;
          if (details instanceof HTMLDetailsElement && !details.open) {
            positionSettingsMenu(details);
          }
          prepareAnimatedMenuFromSummary(event.currentTarget, event);
        }}
      >
        <SettingsIcon />
      </summary>
      <div
        className="topbar-settings__menu section-settings__menu"
        data-animated-menu
        role="group"
        aria-label="Settings"
      >
        {/*
         * General specification: keep settings grouped in this order—sliders, dropdown menus,
         * binary toggles, typable numeric fields, and buttons. Keep transfer controls in compact
         * rows grouped by the scope of the transferred settings.
         */}
        <div className="settings-group settings-group--sliders" role="group" aria-label="Sliders">
          <label className="settings-range-control">
            <span>Markdown box opacity</span>
            <input
              aria-label="Markdown box opacity"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={markdownBoxAppearance.opacity}
              disabled={clientReadOnly}
              onChange={(event) =>
                onMarkdownBoxAppearanceChange({
                  ...markdownBoxAppearance,
                  opacity: Number(event.target.value),
                })
              }
            />
            <output>{Math.round(markdownBoxAppearance.opacity * 100)}%</output>
          </label>
          <label className="settings-range-control">
            <span>Rendered Markdown font size</span>
            <input
              aria-label="Rendered Markdown font size"
              type="range"
              min={MARKDOWN_FONT_SIZE_MIN}
              max={MARKDOWN_FONT_SIZE_MAX}
              step={MARKDOWN_FONT_SIZE_STEP}
              value={markdownBoxAppearance.fontSize}
              disabled={clientReadOnly}
              onChange={(event) =>
                onMarkdownBoxAppearanceChange({
                  ...markdownBoxAppearance,
                  fontSize: Number(event.target.value),
                })
              }
            />
            <output>{markdownBoxAppearance.fontSize}px</output>
          </label>
          <label className="settings-range-control">
            <span>App text scale</span>
            <input
              aria-label="App text scale"
              type="range"
              min={APPLICATION_TEXT_SCALE_PERCENT_MIN}
              max={APPLICATION_TEXT_SCALE_PERCENT_MAX}
              step={APPLICATION_TEXT_SCALE_PERCENT_STEP}
              value={textScalePercent}
              disabled={clientReadOnly}
              onChange={(event) => onTextScalePercentChange(Number(event.target.value))}
            />
            <output>{textScalePercent}%</output>
            <ProfileSaveNote authenticatedUsername={authenticatedUsername} />
          </label>
          <label className="settings-range-control">
            <span>Laser trace decay</span>
            <input
              aria-label="Laser trace decay"
              type="range"
              min={LASER_POINTER_DECAY_MIN_SECONDS}
              max={LASER_POINTER_DECAY_MAX_SECONDS}
              step={LASER_POINTER_DECAY_STEP_SECONDS}
              value={laserPointerSettings.decaySeconds}
              disabled={clientReadOnly}
              onChange={(event) =>
                onLaserPointerSettingsChange({ decaySeconds: Number(event.target.value) })
              }
            />
            <output>{laserPointerSettings.decaySeconds.toFixed(1)}s</output>
          </label>
          <label className="settings-range-control">
            <span>Arrow key panning speed</span>
            <input
              aria-label="Arrow key panning speed"
              type="range"
              min={KEYBOARD_PAN_SPEED_MULTIPLIER_MIN}
              max={KEYBOARD_PAN_SPEED_MULTIPLIER_MAX}
              step={KEYBOARD_PAN_SPEED_MULTIPLIER_STEP}
              value={keyboardPanSpeedMultiplier}
              disabled={clientReadOnly}
              onChange={(event) => onKeyboardPanSpeedMultiplierChange(Number(event.target.value))}
            />
            <output>{formatKeyboardPanSpeedMultiplier(keyboardPanSpeedMultiplier)}</output>
            <ProfileSaveNote authenticatedUsername={authenticatedUsername} />
          </label>
        </div>
        <div
          className="settings-group settings-group--dropdowns"
          role="group"
          aria-label="Dropdown menus"
        >
          {hostSession && (
            <label className="settings-select-control">
              <span>Autosave frequency</span>
              <select
                aria-label="Autosave frequency"
                title="Autosave frequency while LAN sharing is disabled"
                value={autosaveIntervalSeconds}
                disabled={clientReadOnly}
                onChange={(event) =>
                  onAutosaveIntervalChange(Number(event.target.value) as AutosaveIntervalSeconds)
                }
              >
                {AUTOSAVE_INTERVAL_SECONDS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {autosaveIntervalLabel(seconds)}
                  </option>
                ))}
              </select>
              <small className="settings-fineprint">Used only while LAN sharing is disabled.</small>
            </label>
          )}
          <label className="settings-select-control">
            <span>Page background</span>
            <select
              aria-label="Page background"
              title="Page background"
              value={applicationPageBackground}
              onChange={(event) =>
                onPageBackgroundChange(
                  event.target.value === "blank" || event.target.value === "ruled"
                    ? event.target.value
                    : "grid",
                )
              }
            >
              <option value="blank">Blank</option>
              <option value="ruled">Ruled</option>
              <option value="grid">Grid</option>
            </select>
          </label>
        </div>
        <div
          className="settings-group settings-group--toggles"
          role="group"
          aria-label="Binary toggles"
        >
          <ToggleSwitch
            className="settings-toggle"
            checked={drawingPreferences.penDrawsTouchNavigates}
            label="Pen draws, touch navigates"
            onChange={onPenDrawsTouchNavigatesChange}
          />
          <ToggleSwitch
            className="settings-toggle"
            checked={palmRejection}
            disabled={clientReadOnly}
            label="Touch input lock"
            title="Touch input is blocked on the fullscreen canvas to prevent accidental touches. Hold the patterned circle in the bottom-right corner to temporarily enable touch for panning or zooming."
            onChange={onPalmRejectionChange}
          />
        </div>
        <div
          className="settings-group settings-group--numeric-fields"
          role="group"
          aria-label="Typable numeric fields"
        >
          <label className="settings-number-control">
            <span>Canvas toolbar height (px)</span>
            <input
              aria-label="Canvas toolbar height"
              type="number"
              min={CANVAS_TOOLBAR_HEIGHT_MIN}
              max={CANVAS_TOOLBAR_HEIGHT_MAX}
              step="1"
              value={canvasToolbarHeightDraft}
              disabled={clientReadOnly}
              onChange={(event) => onCanvasToolbarHeightDraftChange(event.target.value)}
              onBlur={onCanvasToolbarHeightCommit}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <ProfileSaveNote authenticatedUsername={authenticatedUsername} />
          </label>
        </div>
        <div
          className="settings-group settings-group--buttons"
          role="group"
          aria-label="Settings transfer and help actions"
        >
          <div className="settings-profile-transfer">
            {authenticatedUsername !== undefined && (
              <span title="Settings only; passwords, sessions, and access tokens are never included.">
                Profile settings
              </span>
            )}
            <div className="settings-action-row">
              {authenticatedUsername !== undefined && (
                <>
                  <button type="button" onClick={onExportProfileSettings}>
                    Export profile
                  </button>
                  <button
                    type="button"
                    disabled={busy || clientReadOnly}
                    onClick={() => profileSettingsImportRef.current?.click()}
                  >
                    Import profile
                  </button>
                </>
              )}
              <HelpGuides />
            </div>
            {authenticatedUsername !== undefined && (
              <input
                ref={profileSettingsImportRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={onImportProfileSettings}
              />
            )}
            {hostSession && (
              <>
                <span title="Project preferences only; hierarchy, names, pages, and content are never included.">
                  Project settings
                </span>
                <div className="settings-action-row">
                  <button
                    type="button"
                    disabled={busy || clientReadOnly}
                    onClick={onExportProjectSettings}
                  >
                    Export project
                  </button>
                  <button
                    type="button"
                    disabled={busy || clientReadOnly}
                    onClick={() => projectSettingsImportRef.current?.click()}
                  >
                    Import project
                  </button>
                </div>
                <input
                  ref={projectSettingsImportRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={onImportProjectSettings}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}

function positionSettingsMenu(details: HTMLDetailsElement): void {
  const summary = details.firstElementChild;
  const menu = [...details.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.animatedMenu !== undefined,
  );
  if (!(summary instanceof HTMLElement) || menu === undefined) return;

  const summaryBounds = summary.getBoundingClientRect();
  const detailsBounds = details.getBoundingClientRect();
  const previousAnimation = menu.style.animation;
  const previousTransform = menu.style.transform;
  menu.style.animation = "none";
  menu.style.transform = "none";
  const menuWidth =
    menu.getBoundingClientRect().width ||
    Math.min(18 * 16, Math.max(0, window.innerWidth - SETTINGS_MENU_GUTTER * 2));
  menu.style.animation = previousAnimation;
  menu.style.transform = previousTransform;

  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const left = Math.max(
    SETTINGS_MENU_GUTTER,
    Math.min(summaryBounds.left, viewportWidth - menuWidth - SETTINGS_MENU_GUTTER),
  );
  const top = summaryBounds.bottom + SETTINGS_MENU_GAP;
  const maxHeight = Math.max(0, viewportHeight - top - SETTINGS_MENU_GUTTER);
  details.style.setProperty("--section-settings-menu-left", `${left - detailsBounds.left}px`);
  details.style.setProperty("--section-settings-menu-top", `${top - detailsBounds.top}px`);
  details.style.setProperty("--section-settings-menu-max-height", `${maxHeight}px`);
}

function formatKeyboardPanSpeedMultiplier(value: number): string {
  return `${value}×`;
}

function ProfileSaveNote({
  authenticatedUsername,
}: {
  readonly authenticatedUsername: string | undefined;
}) {
  if (authenticatedUsername !== undefined) return null;
  return <small className="settings-fineprint">Saved when a profile is signed in.</small>;
}

export function HelpGuides() {
  return (
    <a
      className="settings-guide-link"
      href="./docs.html"
      target="_blank"
      rel="noopener noreferrer"
      title="Open the full guide in a new tab"
    >
      Guide
    </a>
  );
}

function autosaveIntervalLabel(seconds: AutosaveIntervalSeconds): string {
  if (seconds === 0) return "Never";
  if (seconds < 60) return `${seconds} seconds`;
  return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
}
