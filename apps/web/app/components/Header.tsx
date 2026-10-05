"use client";

import { useTheme } from "../theme";
import WalletButton from "./WalletButton";
import {
  brand,
  brandTag,
  navCta,
  navLink,
  navRow,
  headerBar,
  headerInner,
  themeBtn,
} from "./styles";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/deals/new", label: "New deal" },
  { href: "/review", label: "Review queue" },
];

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="1.5"
        y="1.5"
        width="21"
        height="21"
        rx="6"
        stroke="var(--accent)"
        strokeWidth="1.6"
      />
      <path
        d="M8 12.5l2.6 2.6L16.5 9.5"
        stroke="var(--accent)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3a9 9 0 0 1 0 18V3z" fill="currentColor" />
    </svg>
  );
}

export default function Header() {
  const { theme, toggle } = useTheme();
  return (
    <header style={headerBar}>
      <div style={headerInner}>
        <a href="/" style={brand}>
          <BrandMark />
          <span>Midman</span>
          <span style={brandTag}>escrow</span>
        </a>
        <nav style={navRow} aria-label="Primary">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} style={navLink}>
              {l.label}
            </a>
          ))}
          <a href="/deals/new" style={navCta}>
            Create deal
          </a>
          <WalletButton />
          <button
            type="button"
            onClick={toggle}
            style={themeBtn}
            title={`Color theme: ${theme}. Click to switch.`}
            aria-label="Toggle color theme"
          >
            <ThemeIcon />
          </button>
        </nav>
      </div>
    </header>
  );
}
