export interface ChipOption<T extends string> {
  key: T;
  label: string;
}

interface VaultChipsProps<T extends string> {
  options: ChipOption<T>[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel?: string;
}

export default function VaultChips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: VaultChipsProps<T>) {
  return (
    <div className="vchips" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className="vchip"
          role="tab"
          aria-pressed={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
