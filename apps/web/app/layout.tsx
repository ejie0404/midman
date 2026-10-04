import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Midman Escrow (dev)",
  description: "Private-link USDC escrow on Base. No on-chain action without explicit wallet authorization.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
