import { HeroPrimary } from "@/components/sections/HeroPrimary";
import { HeroReasoning } from "@/components/sections/HeroReasoning";
import { HeroOrchestration } from "@/components/sections/HeroOrchestration";
import { HeroTerminal } from "@/components/sections/HeroTerminal";
import { HeroCTA } from "@/components/sections/HeroCTA";

export default function Home() {
  return (
    <main className="bg-zinc-950 text-zinc-100">
      <HeroPrimary />
      <HeroReasoning />
      <HeroOrchestration />
      <HeroTerminal />
      <HeroCTA />
    </main>
  );
}
