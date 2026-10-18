import type { Metadata } from "next";
import { Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

/**
 * Two families, both doing a specific job.
 *
 * Space Grotesk for everything a human reads as prose or as display. Every
 * competitor in this category ships Inter, which is why Inter now reads as
 * "unconfigured" rather than "clean"; Space Grotesk keeps the same neutral
 * grotesque skeleton but has enough character — the flat-topped `a`, the squared
 * terminals on `r` and `e` — to survive being set at 60px, which is exactly
 * where a landing page's headline lives.
 *
 * Geist Mono for anything technical: the eyebrow labels, the key prefixes, the
 * status words, and the terminal transcript. It is not chosen on merit — it is
 * the mono `packages/nah-studio` sets its micro-labels in and the mono the
 * `apps/nah` docs use, so a 9px label here and a 9px label there are the same
 * shape. Matching the rest of the product beats having the better mono.
 *
 * Both are variable, subset to latin, and served by next/font — self-hosted,
 * preloaded, and `font-display: swap`, so the page paints in the fallback first
 * rather than waiting on the network.
 */

const spaceGrotesk = Space_Grotesk({
  variable: "--font-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nah Cloud — hosted agent runtime",
  description:
    "Run the terminal UI against a remote agent runtime with a real filesystem.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}