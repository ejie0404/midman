import {
  brand,
  brandTag,
  footerBar,
  footerInner,
  footerLink,
} from "./styles";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/deals/new", label: "New deal" },
  { href: "/review", label: "Review queue" },
];

export default function Footer() {
  return (
    <footer style={footerBar}>
      <div style={footerInner}>
        <div>
          <span style={{ ...brand, fontSize: 14 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
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
            <span>Midman</span>
            <span style={brandTag}>escrow</span>
          </span>
          <p style={{ margin: "8px 0 0", maxWidth: 380 }}>
            Private-link USDC escrow on Base. No on-chain action without explicit
            wallet authorization.
          </p>
        </div>
        <div>
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} style={footerLink}>
              {l.label}
            </a>
          ))}
          <p style={{ margin: "8px 0 0" }}>
            Midman V1 · dev build · inclusion is the only truth
          </p>
        </div>
      </div>
    </footer>
  );
}
