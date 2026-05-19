"use client";

import Image from "next/image";
import { Accordion } from "@/components/ui/Accordion";
import { faqs } from "@/lib/data";
import { RevealText } from "@/components/ui/RevealText";

export function FAQ() {
  return (
    <section className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
      <div className="grid grid-cols-3 items-baseline text-xs uppercase tracking-[0.2em] text-muted">
        <span>© Help Center — ヘルプ</span>
        <span className="text-center">(WDX® — 11)</span>
        <span className="text-right">Clarifications</span>
      </div>

      <div className="mt-20 grid grid-cols-1 gap-12 md:grid-cols-12 md:gap-16">
        <div className="md:col-span-5">
          <div className="relative aspect-[4/5] w-full max-w-sm overflow-hidden rounded-md bg-surface-2">
            {/* Placeholder image area — drop your photo into /public/images/about.jpg */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-white/0 to-black/40" />
          </div>
          <RevealText
            as="h2"
            className="mt-10 max-w-md font-display text-4xl leading-[1.05] tracking-tight md:text-5xl"
          >
            Clarifying deliverables before they begin — with real process and honest answers.
          </RevealText>
        </div>
        <div className="md:col-span-7">
          <Accordion items={faqs} />
        </div>
      </div>
    </section>
  );
}
