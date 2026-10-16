import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider, THEME_BOOT_SCRIPT } from "./theme";
import Header from "./components/Header";
import Footer from "./components/Footer";
import { SessionProvider } from "./components/useSession";

// Self-hosted at build time by next/font: no runtime requests to Google.
const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Midman — USDC escrow on Base",
  description:
    "Hold USDC in escrow on Base until the deal is done. Both sides sign the same terms, funds release on delivery, and disputes go to an independent panel.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <SessionProvider>
            <Header />
            {children}
            <Footer />
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
