"use client";

import { motion, useInView, useMotionValue, animate } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "./SectionHeader";
import { awards } from "@/lib/data";

export function Awards() {
  return (
    <section className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© Awards — アワード"
        center="(WDX® — 07)"
        right="Recognition"
      />

      <h2 className="mb-20 max-w-3xl font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
        Recognised by the people whose opinion matters most — the ones who do the work.
      </h2>

      <div className="grid grid-cols-2 gap-px bg-white/10 md:grid-cols-4">
        {awards.map((a, i) => (
          <AwardCell key={i} count={a.count} label={a.label} index={i} />
        ))}
      </div>
    </section>
  );
}

function AwardCell({
  count,
  label,
  index,
}: {
  count: string;
  label: string;
  index: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const mv = useMotionValue(0);
  const [display, setDisplay] = useState("00");
  const target = parseInt(count, 10);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(mv, target, {
      duration: 1.4,
      ease: [0.22, 1, 0.36, 1],
      delay: index * 0.1,
      onUpdate: (v) => setDisplay(String(Math.round(v)).padStart(2, "0")),
    });
    return controls.stop;
  }, [inView, mv, target, index]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={inView ? { opacity: 1 } : {}}
      transition={{ duration: 0.6, delay: index * 0.06 }}
      className="flex min-h-[200px] flex-col items-start justify-between bg-black p-8 md:p-10"
    >
      <span className="text-xs uppercase tracking-[0.2em] text-muted">
        {String(index + 1).padStart(2, "0")}x
      </span>
      <div>
        <div className="font-display text-5xl font-semibold tabular-nums md:text-7xl">
          {display}
          <span className="text-muted">×</span>
        </div>
        <div className="mt-2 text-sm uppercase tracking-[0.2em] text-muted-2">
          {label}
        </div>
      </div>
    </motion.div>
  );
}
