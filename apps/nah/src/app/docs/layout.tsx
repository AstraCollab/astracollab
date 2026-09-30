import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Documentation | Not Another Harness",
    template: "%s | NAH Docs",
  },
  description:
    "Guides and API references for the NAH coding-agent runtime and CLI.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
