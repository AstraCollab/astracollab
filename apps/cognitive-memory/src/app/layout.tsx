import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  title: {
    default: "Cognitive Memory — memory for LLM agents",
    template: "%s · Cognitive Memory"
  },
  description:
    "Your agent forgets everything between sessions. Cognitive Memory keeps the durable facts it is told and hands back the relevant ones each turn — indexed by default, full bodies only where something earned them.",
  openGraph: {
    title: "Cognitive Memory",
    description:
      "Deterministic four-tier memory for agents, served as a credentialed storage layer you can read end to end.",
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
