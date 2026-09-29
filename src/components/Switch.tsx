import './Switch.css';

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  describedBy?: string;
};

/** The surrounding control row supplies the visible label. */
export default function Switch({ checked, onCheckedChange, disabled = false, label, describedBy }: SwitchProps) {
  return <button
    type="button"
    className="switch-control"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    aria-describedby={describedBy}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
  >
    <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
  </button>;
}
