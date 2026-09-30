import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://nah.astracollab.com"),
  title: "Not Another Harness — One agent loop. Every step in view.",
  description: "An open source TypeScript coding-agent runtime and CLI with a manual step-capped loop, bounded tools, streaming events, and explicit permission controls.",
  authors: [{ name: "AstraCollab" }],
  robots: "index, follow",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://nah.astracollab.com",
    title: "Not Another Harness — One agent loop. Every step in view.",
    description: "An open source TypeScript coding-agent runtime and CLI with a manual step-capped loop, bounded tools, streaming events, and explicit permission controls.",
    siteName: "nah",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "nah" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">
        {children}
      </body>
    </html>
  );
}
