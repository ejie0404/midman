import type { CSSProperties } from "react";

// Shared design system. All colors reference CSS variables defined in
// app/globals.css, so the midnight/sage theme toggle re-skins every page
// that imports these styles without touching page code.

const FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";

export const page: CSSProperties = {
  maxWidth: 920,
  margin: "0 auto",
  padding: "40px 20px 72px",
  fontFamily: FONT,
  lineHeight: 1.55,
  color: "var(--text)",
};

export const card: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 18,
  margin: "16px 0",
};

export const label: CSSProperties = {
  display: "block",
  fontWeight: 600,
  margin: "12px 0 4px",
  color: "var(--text)",
};

export const input: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  fontSize: 14,
  boxSizing: "border-box",
  background: "var(--card-2)",
  color: "var(--text)",
};

export const button: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "var(--accent-ink)",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 650,
  marginRight: 8,
  marginTop: 8,
  transition: "filter .15s ease, transform .15s ease",
};

export const secondaryButton: CSSProperties = {
  ...button,
  background: "transparent",
  color: "var(--accent)",
};

export const dangerButton: CSSProperties = {
  ...button,
  background: "transparent",
  color: "var(--danger)",
  borderColor: "var(--danger)",
};

export const error: CSSProperties = {
  background: "rgba(255, 123, 114, 0.08)",
  border: "1px solid rgba(255, 123, 114, 0.35)",
  borderRadius: 8,
  padding: 10,
  margin: "12px 0",
  color: "var(--danger)",
};

export const warning: CSSProperties = {
  background: "rgba(227, 179, 65, 0.08)",
  border: "1px solid rgba(227, 179, 65, 0.35)",
  borderRadius: 8,
  padding: 10,
  margin: "12px 0",
  color: "var(--warn)",
};

export const ok: CSSProperties = {
  background: "var(--accent-dim)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  padding: 10,
  margin: "12px 0",
  color: "var(--accent-2)",
};

export const mono: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  wordBreak: "break-all",
  fontSize: 13,
};

export const nav: CSSProperties = {
  margin: "16px 0",
  fontSize: 14,
  color: "var(--muted)",
};

// --- Landing / shared sections ---

export const hero: CSSProperties = { padding: "72px 0 44px", textAlign: "center" };

export const heroBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--card)",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 13,
  color: "var(--muted)",
};

export const gradientText: CSSProperties = {
  background: "linear-gradient(100deg, var(--accent) 10%, var(--accent-2) 90%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

export const heroSub: CSSProperties = {
  color: "var(--muted)",
  maxWidth: 620,
  margin: "0 auto",
  fontSize: 16,
};

export const statRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  justifyContent: "center",
  margin: "30px 0 6px",
};

export const statChip: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--card)",
  borderRadius: 10,
  padding: "8px 14px",
  fontSize: 13,
  color: "var(--muted)",
};

export const section: CSSProperties = { margin: "56px 0" };

export const sectionTitle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  margin: "0 0 6px",
};

export const sectionSub: CSSProperties = {
  color: "var(--muted)",
  margin: "0 0 22px",
  maxWidth: 560,
};

export const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
  gap: 14,
};

export const featureCard: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 18,
};

export const featureIcon: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 9,
  background: "var(--accent-dim)",
  border: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--accent)",
  marginBottom: 12,
};

export const featureTitle: CSSProperties = { fontWeight: 650, fontSize: 15, margin: "0 0 6px" };

export const featureText: CSSProperties = { color: "var(--muted)", fontSize: 14, margin: 0 };

export const steps: CSSProperties = {
  display: "grid",
  gap: 0,
  margin: 0,
  padding: 0,
  listStyle: "none",
};

export const step: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "44px 1fr",
  gap: 16,
  position: "relative",
  paddingBottom: 28,
};

export const stepNum: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: "50%",
  border: "1px solid var(--accent)",
  color: "var(--accent)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
  fontSize: 14,
  background: "var(--card)",
};

export const stepTitle: CSSProperties = { fontWeight: 650, margin: "4px 0 4px" };

export const stepText: CSSProperties = { color: "var(--muted)", fontSize: 14, margin: 0 };

export const ctaPanel: CSSProperties = {
  border: "1px solid var(--border-strong)",
  background: "linear-gradient(120deg, var(--accent-dim), transparent 60%), var(--card)",
  borderRadius: 18,
  padding: "36px 28px",
  textAlign: "center",
};

export const pill: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  border: "1px solid var(--border-strong)",
  padding: "3px 10px",
  fontSize: 12,
  color: "var(--muted)",
};

export const divider: CSSProperties = {
  border: "none",
  borderTop: "1px solid var(--border)",
  margin: "28px 0",
};

export const hint: CSSProperties = { fontSize: 13, color: "var(--muted)", marginTop: 6 };

// --- Header / footer ---

export const headerBar: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 40,
  background: "rgba(6, 9, 6, 0.82)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  borderBottom: "1px solid var(--border)",
};

export const headerInner: CSSProperties = {
  maxWidth: 1080,
  margin: "0 auto",
  padding: "0 20px",
  height: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
};

export const brand: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 9,
  fontWeight: 750,
  fontSize: 16,
  letterSpacing: "-0.01em",
  color: "var(--text)",
  textDecoration: "none",
};

export const brandTag: CSSProperties = {
  fontSize: 10,
  fontWeight: 650,
  color: "var(--accent)",
  border: "1px solid var(--border-strong)",
  borderRadius: 999,
  padding: "2px 7px",
  textTransform: "uppercase",
  letterSpacing: "0.09em",
};

export const navRow: CSSProperties = { display: "flex", alignItems: "center", gap: 4 };

export const navLink: CSSProperties = {
  color: "var(--muted)",
  fontSize: 14,
  fontWeight: 550,
  padding: "7px 11px",
  borderRadius: 8,
  textDecoration: "none",
  transition: "color .15s ease, background .15s ease",
};

export const navCta: CSSProperties = {
  color: "var(--accent-ink)",
  background: "var(--accent)",
  fontSize: 14,
  fontWeight: 650,
  padding: "8px 14px",
  borderRadius: 8,
  textDecoration: "none",
  marginLeft: 6,
};

export const themeBtn: CSSProperties = {
  marginLeft: 8,
  width: 34,
  height: 34,
  borderRadius: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--card)",
  color: "var(--accent)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

export const walletBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  marginLeft: 8,
  height: 34,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--card)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  whiteSpace: "nowrap",
  transition: "border-color .15s ease, background .15s ease",
};

export const walletError: CSSProperties = {
  color: "var(--warn)",
  fontSize: 13,
  cursor: "help",
};

export const footerBar: CSSProperties = {
  borderTop: "1px solid var(--border)",
  marginTop: "72px",
  padding: "28px 20px 40px",
  color: "var(--muted)",
  fontSize: 13,
};

export const footerInner: CSSProperties = {
  maxWidth: 1080,
  margin: "0 auto",
  display: "flex",
  flexWrap: "wrap",
  gap: 18,
  justifyContent: "space-between",
  alignItems: "flex-start",
};

export const footerLink: CSSProperties = {
  color: "var(--muted)",
  marginRight: 16,
  textDecoration: "none",
};
