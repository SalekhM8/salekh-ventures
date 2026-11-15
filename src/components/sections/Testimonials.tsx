"use client";

import { motion } from "framer-motion";
import { SectionHeader } from "./SectionHeader";
import { testimonials } from "@/lib/data";
import { RollButton } from "@/components/ui/RollButton";

export function Testimonials() {
  return (
    <section className="border-t border-black/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© Words"
        center="(WDX® — 06)"
        right="Testimonials"
      />

      <div className="mb-16 flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
        <h2 className="max-w-3xl font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
          Quiet praise from founders and operators who shipped with us.
        </h2>
        <RollButton href="/contact" variant="secondary" size="md">
          Get in touch
        </RollButton>
      </div>

      <div
        data-lenis-prevent
        className="-mx-6 flex snap-x snap-mandatory gap-6 overflow-x-auto px-6 pb-4 md:-mx-10 md:px-10 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none" }}
      >
        {testimonials.map((t, i) => (
          <motion.figure
            key={i}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.7, delay: i * 0.06 }}
            className="flex w-[85vw] shrink-0 snap-start flex-col justify-between rounded-2xl border border-black/10 bg-surface p-8 md:w-[480px] md:p-10"
          >
            <blockquote className="font-display text-xl leading-snug md:text-2xl">
              “{t.quote}”
            </blockquote>
            <figcaption className="mt-10 flex items-center gap-4">
              <div className="h-10 w-10 rounded-full bg-gradient-to-br from-black/20 to-black/5" />
              <div>
                <div className="text-sm">{t.name}</div>
                <div className="text-xs text-muted">{t.role}</div>
              </div>
            </figcaption>
          </motion.figure>
        ))}
      </div>
    </section>
  );
}
