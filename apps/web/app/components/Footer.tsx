import { BrandMark } from "./ui";

const HUB = process.env["NEXT_PUBLIC_HUB_ADDRESS"] ?? "";
const EXPLORER = process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "https://basescan.org";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container row spread" style={{ alignItems: "flex-start", gap: 24 }}>
        <div style={{ maxWidth: 420 }}>
          <span className="brand" style={{ fontSize: 14 }}>
            <BrandMark size={18} />
            Midman
          </span>
          <p style={{ marginTop: 8 }}>
            USDC escrow on Base. Funds are held by an on-chain contract, not by Midman, and nothing moves without
            your wallet&apos;s signature.
          </p>
        </div>
        <div className="row" style={{ gap: 20, alignItems: "flex-start" }}>
          <div className="stack" style={{ gap: 6 }}>
            <span className="eyebrow">Product</span>
            <a href="/deals">My deals</a>
            <a href="/deals/new">New deal</a>
            <a href="/#fees">Fees</a>
            <a href="/#faq">FAQ</a>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <span className="eyebrow">Trust</span>
            {/^0x[0-9a-fA-F]{40}$/.test(HUB) ? (
              <a href={`${EXPLORER}/address/${HUB}`} target="_blank" rel="noreferrer">
                Escrow contract
              </a>
            ) : null}
            <a href="/emergency.html">Emergency exit</a>
            <a href="/review">Reviewer sign-in</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
