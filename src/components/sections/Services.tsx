"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { SectionHeader } from "./SectionHeader";
import { services } from "@/lib/data";

export function Services() {
  return (
    <section className="border-t border-black/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© Capabilities"
        center="(WDX® — 04)"
        right="What we do"
      />

      <h2 className="mb-20 max-w-4xl font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
        Six capabilities, one engineer. Every part of the build handled in-house.
      </h2>

      <div className="grid grid-cols-1 gap-px bg-black/10 md:grid-cols-2 lg:grid-cols-3">
        {services.map((s, i) => (
          <ServiceCard key={s.n} item={s} index={i} />
        ))}
      </div>
    </section>
  );
}

function ServiceCard({
  item,
  index,
}: {
  item: (typeof services)[number];
  index: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
      className="group relative flex min-h-[260px] flex-col justify-between bg-white p-8 transition-colors hover:bg-surface md:p-10"
    >
      <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-muted">
        <span>{item.n}</span>
        <span className="opacity-0 transition-opacity group-hover:opacity-100">
          →
        </span>
      </div>
      <div>
        <h3 className="font-display text-2xl tracking-tight md:text-3xl">
          {item.title}
        </h3>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-2">
          {item.desc}
        </p>
      </div>
    </motion.div>
  );
}
