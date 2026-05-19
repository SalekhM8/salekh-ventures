"use client";

import { motion } from "framer-motion";
import { RevealText } from "@/components/ui/RevealText";
import { RollButton } from "@/components/ui/RollButton";

export function Hero() {
  return (
    <section className="relative flex min-h-screen flex-col justify-between overflow-hidden px-6 pb-10 pt-32 md:px-10 md:pt-40">
      <div className="grid grid-cols-3 items-baseline text-xs uppercase tracking-[0.2em] text-muted">
        <span>© Salekh Ventures — ベンチャーズ</span>
        <span className="text-center">(WDX® — 01)</span>
        <span className="text-right">Index</span>
      </div>

      <div className="my-auto py-16 md:py-24">
        <h1 className="font-display text-[14vw] font-semibold leading-[0.9] tracking-[-0.03em] md:text-[8.5vw]">
          <RevealText as="span" className="block">
            Production-grade Software,
          </RevealText>
          <RevealText as="span" className="block" delay={0.1}>
            Shipped in Weeks,
          </RevealText>
          <RevealText as="span" className="block" delay={0.2}>
            Built to Last <span className="italic text-muted-2">イメージ</span>.
          </RevealText>
        </h1>
      </div>

      <div className="grid grid-cols-1 items-end gap-8 md:grid-cols-3">
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.8 }}
          className="max-w-xs text-sm leading-relaxed text-muted-2"
        >
          A studio building production-grade web platforms for founders and
          operators who need to ship something serious, not a prototype.
        </motion.p>
        <div className="flex justify-start md:justify-center">
          <RollButton href="/contact" size="md" variant="primary">
            Start a project
          </RollButton>
        </div>
        <div className="flex items-center justify-start gap-3 text-xs uppercase tracking-[0.2em] text-muted md:justify-end">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          Available for new work
        </div>
      </div>
    </section>
  );
}
