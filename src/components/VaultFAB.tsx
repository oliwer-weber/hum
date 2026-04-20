interface VaultFABProps {
  label: string;
  onClick: () => void;
  ariaLabel?: string;
}

export default function VaultFAB({ label, onClick, ariaLabel }: VaultFABProps) {
  return (
    <button
      type="button"
      className="vfab"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
    >
      <span className="vfab-icon" aria-hidden="true">+</span>
      <span>{label}</span>
    </button>
  );
}
