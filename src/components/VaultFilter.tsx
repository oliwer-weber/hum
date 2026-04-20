interface VaultFilterProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

export default function VaultFilter({
  value,
  onChange,
  placeholder = "Filter…",
  ariaLabel,
}: VaultFilterProps) {
  return (
    <div className="vfilter" role="search">
      <span className="vfilter-icon" aria-hidden="true">⌕</span>
      <input
        className="vfilter-input"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onChange("");
        }}
        aria-label={ariaLabel ?? placeholder}
      />
      <button
        type="button"
        className="vfilter-clear"
        onClick={() => onChange("")}
        aria-label="Clear filter"
        tabIndex={value ? 0 : -1}
      >
        ✕
      </button>
    </div>
  );
}
