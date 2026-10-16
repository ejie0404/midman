// Shared UI primitives over the CSS classes in app/globals.css. Server- and
// client-safe (no hooks). Pages compose these instead of inline style objects.

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

function btnClass(variant: Variant, size: Size, block: boolean, extra?: string): string {
  return ["btn", `btn-${variant}`, size !== "md" ? `btn-${size}` : "", block ? "btn-block" : "", extra ?? ""]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; block?: boolean }) {
  return <button type={type} className={btnClass(variant, size, block, className)} {...rest} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  block = false,
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size; block?: boolean }) {
  return <a className={btnClass(variant, size, block, className)} {...rest} />;
}

export function Card({
  children,
  title,
  action,
  className,
}: {
  children: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={["card", className ?? ""].filter(Boolean).join(" ")}>
      {title || action ? (
        <div className="card-header">
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export type Tone = "neutral" | "info" | "teal" | "warning" | "violet" | "success" | "danger";

export function Chip({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger" | "neutral";
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <div>
        {title ? <strong style={{ display: "block", marginBottom: 2 }}>{title}</strong> : null}
        {children}
      </div>
    </div>
  );
}

/** Segmented control (radio-like button group). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function KeyValues({ rows }: { rows: readonly { label: ReactNode; value: ReactNode; total?: boolean }[] }) {
  return (
    <dl className="kv">
      {rows.map((row, i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt className={row.total ? "kv-total" : undefined}>{row.label}</dt>
          <dd className={row.total ? "kv-total" : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="7" fill="var(--primary)" />
      <path d="M7 12.4l3.1 3.1L17 8.6" stroke="var(--on-primary)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small stroke icons (24px grid, currentColor). */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

export type IconName =
  | "lock"
  | "pen"
  | "shield"
  | "scale"
  | "clock"
  | "check"
  | "menu"
  | "close"
  | "sun"
  | "moon"
  | "monitor"
  | "plus"
  | "arrow-right"
  | "wallet"
  | "alert";

const ICONS: Record<IconName, ReactNode> = {
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  shield: <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z" />,
  scale: (
    <>
      <path d="M12 4v16M5 20h14M7 8h10" />
      <path d="M7 8l-3 6a3 3 0 0 0 6 0Z M17 8l-3 6a3 3 0 0 0 6 0Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  wallet: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v4" />
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <circle cx="16" cy="13.5" r="1.2" fill="currentColor" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3Z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
};
