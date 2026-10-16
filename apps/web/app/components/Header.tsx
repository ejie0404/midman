"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme, type ThemeMode } from "../theme";
import { useSession } from "./useSession";
import { BrandMark, Button, Icon, type IconName } from "./ui";
import { shortAddress } from "../../lib/dealPhase";

const LINKS = [
  { href: "/deals", label: "My deals" },
  { href: "/deals/new", label: "New deal" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#fees", label: "Fees" },
];

const THEME_ICON: Record<ThemeMode, IconName> = { system: "monitor", light: "sun", dark: "moon" };
const THEME_LABEL: Record<ThemeMode, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };

function AccountButton() {
  const { session, loading, connect, disconnect, error } = useSession();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (loading) return <span className="skeleton" style={{ width: 120, height: 38, display: "inline-block" }} />;

  if (!session) {
    return (
      <Button
        variant="primary"
        disabled={busy}
        title={error ?? "Connect your wallet and sign a one-time login message. No funds are authorized."}
        onClick={() => {
          setBusy(true);
          void connect()
            .catch(() => undefined)
            .finally(() => setBusy(false));
        }}
      >
        <Icon name="wallet" size={16} />
        {busy ? "Check your wallet…" : "Sign in"}
      </Button>
    );
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Button variant="secondary" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)" }} aria-hidden />
        <span className="mono">{shortAddress(session.wallet)}</span>
      </Button>
      {open ? (
        <div
          role="menu"
          className="card"
          style={{ position: "absolute", right: 0, top: 46, minWidth: 220, padding: 8, boxShadow: "var(--shadow)" }}
        >
          <div className="small muted" style={{ padding: "6px 8px" }}>
            Signed in as <span className="mono">{shortAddress(session.wallet)}</span>
          </div>
          <a role="menuitem" href="/deals" className="btn btn-ghost btn-block" style={{ justifyContent: "flex-start" }}>
            My deals
          </a>
          <button
            role="menuitem"
            type="button"
            className="btn btn-ghost btn-block"
            style={{ justifyContent: "flex-start" }}
            onClick={() => {
              setOpen(false);
              void disconnect();
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function Header() {
  const { mode, cycle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [path, setPath] = useState("");

  useEffect(() => setPath(window.location.pathname), []);

  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <a href="/" className="brand" aria-label="Midman home">
          <BrandMark />
          Midman
        </a>
        <nav className="nav-links" aria-label="Primary">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} aria-current={path === link.href ? "page" : undefined}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn hide-mobile"
            onClick={cycle}
            aria-label={`${THEME_LABEL[mode]} (click to change)`}
            title={THEME_LABEL[mode]}
          >
            <Icon name={THEME_ICON[mode]} size={17} />
          </button>
          <AccountButton />
          <button
            type="button"
            className="icon-btn menu-toggle"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name={menuOpen ? "close" : "menu"} />
          </button>
        </div>
      </div>
      <nav className="mobile-menu" data-open={menuOpen} aria-label="Mobile">
        {LINKS.map((link) => (
          <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
            {link.label}
          </a>
        ))}
        <button type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start" }} onClick={cycle}>
          <Icon name={THEME_ICON[mode]} size={17} /> {THEME_LABEL[mode]}
        </button>
      </nav>
    </header>
  );
}
