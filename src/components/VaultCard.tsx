import React from "react";

export type CardCollection = "projects" | "library" | "notes";
export type CardVariant = "hero" | "content" | "pivot" | "project";
export type CardShape = "folder";

interface VaultCardProps {
  variant: CardVariant;
  shape?: CardShape;
  collection?: CardCollection;
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  recentItems?: string[];
  onClick?: () => void;
  onMenu?: () => void;
  menu?: React.ReactNode;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export default function VaultCard({
  variant,
  shape,
  collection,
  title,
  subtitle,
  meta,
  icon,
  recentItems,
  onClick,
  onMenu,
  menu,
  ariaLabel,
  children,
}: VaultCardProps) {
  const dataAttrs: Record<string, string> = { "data-variant": variant };
  if (collection) dataAttrs["data-collection"] = collection;
  if (shape) dataAttrs["data-shape"] = shape;

  const cardInner = (
    <button
      type="button"
      className="vcard"
      onClick={onClick}
      aria-label={ariaLabel ?? title}
      {...dataAttrs}
    >
      {icon && <span className="vcard-icon" aria-hidden="true">{icon}</span>}
      <div className="vcard-title">{title}</div>
      {subtitle && <div className="vcard-subtitle">{subtitle}</div>}
      {meta && <div className="vcard-meta">{meta}</div>}
      {children}
      {recentItems && (
        <div className="vcard-recent-strip" aria-hidden="true">
          {recentItems.length === 0 ? (
            <div className="vcard-recent-empty">Nothing here yet</div>
          ) : (
            recentItems.slice(0, 2).map((item, i) => (
              <div key={i} className="vcard-recent-item">{item}</div>
            ))
          )}
        </div>
      )}
    </button>
  );

  if (!onMenu) return cardInner;

  return (
    <div className="vcard-wrapper" {...(collection && { "data-collection": collection })}>
      {cardInner}
      <button
        type="button"
        className="vcard-menu-btn"
        onClick={(e) => {
          e.stopPropagation();
          onMenu();
        }}
        aria-label={`Actions for ${title}`}
      >
        ⋯
      </button>
      {menu}
    </div>
  );
}
