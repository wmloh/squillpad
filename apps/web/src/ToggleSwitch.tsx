import type { ReactNode } from "react";

export interface ToggleSwitchProps {
  readonly checked: boolean;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly onChange: (checked: boolean) => void;
  readonly title?: string;
}

/** Renders a native checkbox with a consistent switch presentation. */
export function ToggleSwitch({
  checked,
  className,
  disabled = false,
  label,
  onChange,
  title,
}: ToggleSwitchProps) {
  const classes = className === undefined ? "toggle-switch" : `toggle-switch ${className}`;
  return (
    <label className={classes} title={title}>
      <input
        className="toggle-switch__input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-switch__track" aria-hidden="true">
        <span className="toggle-switch__thumb" />
      </span>
      <span className="toggle-switch__label">{label}</span>
    </label>
  );
}
