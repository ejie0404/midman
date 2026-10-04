import type { CSSProperties } from "react";

export const page: CSSProperties = {
  maxWidth: 860,
  margin: "0 auto",
  padding: "32px 20px 64px",
  fontFamily: "system-ui, -apple-system, sans-serif",
  lineHeight: 1.55,
  color: "#111",
};

export const card: CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 16,
  margin: "16px 0",
};

export const label: CSSProperties = { display: "block", fontWeight: 600, margin: "12px 0 4px" };

export const input: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #bbb",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};

export const button: CSSProperties = {
  padding: "9px 16px",
  borderRadius: 6,
  border: "1px solid #111",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
  fontSize: 14,
  marginRight: 8,
  marginTop: 8,
};

export const secondaryButton: CSSProperties = {
  ...button,
  background: "#fff",
  color: "#111",
};

export const dangerButton: CSSProperties = {
  ...button,
  background: "#8f1d1d",
  borderColor: "#8f1d1d",
};

export const error: CSSProperties = {
  background: "#fdecec",
  border: "1px solid #d66",
  borderRadius: 6,
  padding: 10,
  margin: "12px 0",
};

export const warning: CSSProperties = {
  background: "#fff7e6",
  border: "1px solid #c90",
  borderRadius: 6,
  padding: 10,
  margin: "12px 0",
};

export const ok: CSSProperties = {
  background: "#eef7ee",
  border: "1px solid #3a3",
  borderRadius: 6,
  padding: 10,
  margin: "12px 0",
};

export const mono: CSSProperties = { fontFamily: "monospace", wordBreak: "break-all", fontSize: 13 };

export const nav: CSSProperties = { margin: "16px 0", fontSize: 14 };
