import type { Metadata } from "next";
import { HowItWorksPage } from "@/components/HowItWorksPage";

export const metadata: Metadata = {
  title: "How it works — nah",
  description: "See how the nah agent loop turns a prompt into bounded, observable work.",
};

export default function Page() {
  return <HowItWorksPage />;
}
