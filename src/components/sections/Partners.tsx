"use client";

import { Marquee } from "@/components/ui/Marquee";
import { partners } from "@/lib/data";
import { SectionHeader } from "./SectionHeader";

export function Partners() {
  return (
    <section className="border-t border-white/5 py-24 md:py-40">
      <div className="px-6 md:px-10">
        <SectionHeader
          left="© Partners — パートナー"
          center="(WDX® — 08)"
          right="Trusted by"
        />
        <h2 className="mb-16 max-w-3xl px-0 font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
          A small, repeat list of clients we&rsquo;re lucky to call partners.
        </h2>
      </div>

      <div className="space-y-6 border-y border-white/5 py-10">
        <Marquee direction="left" speed={50}>
          {partners.map((p) => (
            <PartnerLogo key={p + "-top"} name={p} />
          ))}
        </Marquee>
        <Marquee direction="right" speed={60}>
          {partners.map((p) => (
            <PartnerLogo key={p + "-bottom"} name={p} />
          ))}
        </Marquee>
      </div>
    </section>
  );
}

function PartnerLogo({ name }: { name: string }) {
  return (
    <span className="font-display text-3xl uppercase tracking-tight text-muted-2 transition-colors hover:text-white md:text-5xl">
      {name}
    </span>
  );
}
