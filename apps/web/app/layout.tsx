import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./theme";
import Header from "./components/Header";
import Footer from "./components/Footer";

export const metadata: Metadata = {
  title: "Midman Escrow — private-link USDC on Base",
  description:
    "Private-link USDC escrow on Base. No on-chain action without explicit wallet authorization.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="midnight">
      <body>
        <ThemeProvider>
          <Header />
          {children}
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}
