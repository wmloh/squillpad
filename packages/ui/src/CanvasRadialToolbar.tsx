import type { CSSProperties, Dispatch, SetStateAction } from "react";

import { INK_PALETTE, type DrawingTool } from "./drawing-preferences";
import type { Point } from "./canvas-camera";

export interface RadialMenuState {
  readonly anchor: Point;
  readonly pointerId: number;
}

export interface RadialSectorGlow {
  readonly id: string;
  readonly path: string;
}

export type RadialTool = Extract<DrawingTool, "text" | "pen" | "highlighter" | "eraser" | "laser">;

export const RADIAL_LONG_PRESS_MS = 500;
export const RADIAL_HOLD_CANCEL_DISTANCE_SCREEN_PX = 8;
export const RADIAL_MENU_DIAMETER_SCREEN_PX = 220;
export const RADIAL_MENU_EXTENT_SCREEN_PX = RADIAL_MENU_DIAMETER_SCREEN_PX / 2;

const RADIAL_MENU_BASE_DIAMETER_SCREEN_PX = 206;
const RADIAL_MENU_SCALE = RADIAL_MENU_DIAMETER_SCREEN_PX / RADIAL_MENU_BASE_DIAMETER_SCREEN_PX;
const RADIAL_MENU_RADIUS = 100 * RADIAL_MENU_SCALE;
const RADIAL_COLOR_INNER_RADIUS = 20 * RADIAL_MENU_SCALE;
const RADIAL_COLOR_OUTER_RADIUS = 56 * RADIAL_MENU_SCALE;
const RADIAL_TOOL_INNER_RADIUS = RADIAL_COLOR_OUTER_RADIUS;
const RADIAL_TOOL_OUTER_RADIUS = RADIAL_MENU_RADIUS;
const RADIAL_TOOL_LABEL_RADIUS = (RADIAL_TOOL_INNER_RADIUS + RADIAL_TOOL_OUTER_RADIUS) / 2;
const RADIAL_MENU_VIEW_BOX = `-${RADIAL_MENU_EXTENT_SCREEN_PX} -${RADIAL_MENU_EXTENT_SCREEN_PX} ${RADIAL_MENU_DIAMETER_SCREEN_PX} ${RADIAL_MENU_DIAMETER_SCREEN_PX}`;

const RADIAL_TOOLS: readonly { readonly tool: RadialTool; readonly label: string }[] = [
  { tool: "text", label: "Text" },
  { tool: "pen", label: "Pen" },
  { tool: "highlighter", label: "Highlight" },
  { tool: "eraser", label: "Erase" },
  { tool: "laser", label: "Laser" },
];

interface CanvasRadialToolbarProps {
  readonly radialMenu: RadialMenuState | undefined;
  readonly overlayZIndex: number;
  readonly readOnly: boolean;
  readonly tool: DrawingTool;
  readonly radialPalette: readonly string[];
  readonly radialActiveColor: string;
  readonly radialSectorGlow: RadialSectorGlow | undefined;
  readonly onSectorGlowChange: Dispatch<SetStateAction<RadialSectorGlow | undefined>>;
  readonly onToolChange: (tool: RadialTool) => void;
  readonly onColorChange: (color: string) => void;
  readonly onClose: () => void;
}

export function CanvasRadialToolbar({
  radialMenu,
  overlayZIndex,
  readOnly,
  tool,
  radialPalette,
  radialActiveColor,
  radialSectorGlow,
  onSectorGlowChange,
  onToolChange,
  onColorChange,
  onClose,
}: CanvasRadialToolbarProps) {
  if (radialMenu === undefined || readOnly) return null;

  const radialMenuStyle = {
    left: radialMenu.anchor.x,
    top: radialMenu.anchor.y,
    zIndex: overlayZIndex,
    "--canvas-radial-menu-diameter": `${RADIAL_MENU_DIAMETER_SCREEN_PX}px`,
    "--canvas-radial-menu-extent": `${RADIAL_MENU_EXTENT_SCREEN_PX}px`,
  } as CSSProperties;

  return (
    <div
      className="canvas-radial-menu"
      role="dialog"
      aria-label="Long-press radial toolbar"
      style={radialMenuStyle}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="canvas-radial-menu__halo" aria-hidden="true" />
      <div className="canvas-radial-menu__glass-layer" aria-hidden="true" />
      <svg className="canvas-radial-menu__disc" viewBox={RADIAL_MENU_VIEW_BOX}>
        <defs>
          {RADIAL_TOOLS.map(({ tool: radialTool }, index) => {
            const angle = -90 + (index - 1) * (360 / RADIAL_TOOLS.length);
            return (
              <path
                key={radialTool}
                id={radialToolLabelPathId(radialTool)}
                d={radialArcPath(
                  RADIAL_TOOL_LABEL_RADIUS,
                  angle,
                  360 / RADIAL_TOOLS.length,
                  angle > 0,
                )}
              />
            );
          })}
        </defs>
        <g role="group" aria-label="Radial tools">
          {RADIAL_TOOLS.map(({ tool: radialTool, label }, index) => {
            const angle = -90 + (index - 1) * (360 / RADIAL_TOOLS.length);
            const sectorId = `tool-${radialTool}`;
            const sectorPath = radialSectorPath(
              RADIAL_TOOL_INNER_RADIUS,
              RADIAL_TOOL_OUTER_RADIUS,
              angle,
              360 / RADIAL_TOOLS.length,
            );
            const selectTool = () => {
              onToolChange(radialTool);
              onClose();
            };
            return (
              <g
                key={radialTool}
                className={`canvas-radial-menu__sector canvas-radial-menu__tool${tool === radialTool ? " is-active" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`Choose ${label.toLowerCase()} tool in radial toolbar`}
                aria-pressed={tool === radialTool}
                data-radial-angle={angle}
                onPointerEnter={() => onSectorGlowChange({ id: sectorId, path: sectorPath })}
                onPointerLeave={() =>
                  onSectorGlowChange((current) => (current?.id === sectorId ? undefined : current))
                }
                onFocus={() => onSectorGlowChange({ id: sectorId, path: sectorPath })}
                onBlur={() =>
                  onSectorGlowChange((current) => (current?.id === sectorId ? undefined : current))
                }
                onClick={selectTool}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  selectTool();
                }}
              >
                <path className="canvas-radial-menu__sector-shape" d={sectorPath} />
                <text>
                  <textPath
                    href={`#${radialToolLabelPathId(radialTool)}`}
                    startOffset="50%"
                    textAnchor="middle"
                  >
                    {label}
                  </textPath>
                </text>
              </g>
            );
          })}
        </g>
        <g role="group" aria-label="Radial colors">
          {radialPalette.map((color, index) => {
            const angle = -90 + index * (360 / INK_PALETTE.length);
            const sectorId = `color-${color}-${index}`;
            const sectorPath = radialSectorPath(
              RADIAL_COLOR_INNER_RADIUS,
              RADIAL_COLOR_OUTER_RADIUS,
              angle,
              360 / INK_PALETTE.length,
            );
            const selectColor = () => onColorChange(color);
            return (
              <g
                key={`${color}-${index}`}
                className={`canvas-radial-menu__sector canvas-radial-menu__color${radialActiveColor === color ? " is-active" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`Radial color ${color}`}
                aria-pressed={radialActiveColor === color}
                onPointerEnter={() => onSectorGlowChange({ id: sectorId, path: sectorPath })}
                onPointerLeave={() =>
                  onSectorGlowChange((current) => (current?.id === sectorId ? undefined : current))
                }
                onFocus={() => onSectorGlowChange({ id: sectorId, path: sectorPath })}
                onBlur={() =>
                  onSectorGlowChange((current) => (current?.id === sectorId ? undefined : current))
                }
                onClick={selectColor}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  selectColor();
                }}
              >
                <path
                  className="canvas-radial-menu__sector-shape"
                  d={sectorPath}
                  style={{ fill: color }}
                />
              </g>
            );
          })}
        </g>
        <g className="canvas-radial-menu__center" aria-hidden="true">
          <circle r={RADIAL_COLOR_INNER_RADIUS} />
        </g>
        {radialSectorGlow !== undefined && (
          <path
            className="canvas-radial-menu__sector-glow"
            d={radialSectorGlow.path}
            aria-hidden="true"
          />
        )}
      </svg>
    </div>
  );
}

function radialPoint(radius: number, angle: number): Point {
  const radians = (angle * Math.PI) / 180;
  return { x: radius * Math.cos(radians), y: radius * Math.sin(radians) };
}

function radialToolLabelPathId(tool: RadialTool): string {
  return `canvas-radial-tool-label-${tool}`;
}

function radialArcPath(
  radius: number,
  centerAngle: number,
  sweepAngle: number,
  reverse: boolean,
): string {
  const startAngle = centerAngle - sweepAngle / 2;
  const endAngle = centerAngle + sweepAngle / 2;
  const fromAngle = reverse ? endAngle : startAngle;
  const toAngle = reverse ? startAngle : endAngle;
  const from = radialPoint(radius, fromAngle);
  const to = radialPoint(radius, toAngle);
  return `M ${from.x} ${from.y} A ${radius} ${radius} 0 0 ${reverse ? 0 : 1} ${to.x} ${to.y}`;
}

function radialSectorPath(
  innerRadius: number,
  outerRadius: number,
  centerAngle: number,
  sweepAngle: number,
  offset: Point = { x: 0, y: 0 },
): string {
  const startAngle = centerAngle - sweepAngle / 2;
  const endAngle = centerAngle + sweepAngle / 2;
  const outerStart = radialPoint(outerRadius, startAngle);
  const outerEnd = radialPoint(outerRadius, endAngle);
  const innerEnd = radialPoint(innerRadius, endAngle);
  const innerStart = radialPoint(innerRadius, startAngle);

  return [
    `M ${outerStart.x + offset.x} ${outerStart.y + offset.y}`,
    `A ${outerRadius} ${outerRadius} 0 0 1 ${outerEnd.x + offset.x} ${outerEnd.y + offset.y}`,
    `L ${innerEnd.x + offset.x} ${innerEnd.y + offset.y}`,
    `A ${innerRadius} ${innerRadius} 0 0 0 ${innerStart.x + offset.x} ${innerStart.y + offset.y}`,
    "Z",
  ].join(" ");
}
