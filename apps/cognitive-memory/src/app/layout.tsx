import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  title: {
    default: "Cognitive Memory — every memory line has a reason and a price",
    template: "%s · Cognitive Memory"
  },
  description:
    "A four-tier memory service for agents. Every line injected into a prompt carries the rule that selected it and its token cost, so the per-turn budget is a decision rather than an accident.",
  openGraph: {
    title: "Cognitive Memory",
    description:
      "A four-tier memory service for agents: contradictions kept as first-class records, per-domain reliability, and a bounded, auditable prompt block.",
    type: "website"
  }
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}
