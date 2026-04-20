import { useEffect, useRef, useState } from "react";

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
  const containerRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState<React.CSSProperties>({ opacity: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>('.vchip[aria-pressed="true"]');
    if (!active) {
      setPillStyle({ opacity: 0 });
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    setPillStyle({
      opacity: 1,
      transform: `translateX(${activeRect.left - containerRect.left - 3}px)`,
      width: activeRect.width,
    });
  }, [value, options]);

  return (
    <div
      className="vchips"
      role="tablist"
      aria-label={ariaLabel}
      ref={containerRef}
    >
      <div className="vchips-pill" style={pillStyle} aria-hidden="true" />
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
