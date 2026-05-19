"use client";

import Link from "next/link";
import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { SectionHeader } from "./SectionHeader";
import { works } from "@/lib/data";
import { RollButton } from "@/components/ui/RollButton";

export function Work() {
  return (
    <section className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© Work"
        center="(WDX® — 03)"
        right="Selected"
      />

      <div className="mb-16 flex items-end justify-between gap-8">
        <h2 className="font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
          Selected work,
          <br />
          <span className="text-muted">2022 — 2026</span>
        </h2>
        <RollButton href="/work" variant="secondary" size="md">
          See all works
        </RollButton>
      </div>

      <ul className="divide-y divide-white/10 border-y border-white/10">
        {works.map((w, i) => (
          <WorkRow key={w.n} item={w} index={i} />
        ))}
      </ul>
    </section>
  );
}

function WorkRow({
  item,
  index,
}: {
  item: (typeof works)[number];
  index: number;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  return (
    <motion.li
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
    >
      <Link
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group grid grid-cols-12 items-center gap-4 py-8 transition-colors"
        data-hover
      >
        <span className="col-span-2 text-sm text-muted tabular-nums md:col-span-1">
          {item.n}
        </span>
        <span className="col-span-7 font-display text-2xl tracking-tight transition-transform duration-500 group-hover:translate-x-2 md:col-span-7 md:text-4xl">
          {item.title}
        </span>
        <span className="col-span-3 text-right text-sm text-muted md:col-span-3 md:text-left">
          {item.role}
        </span>
        <span className="hidden text-right text-sm text-muted md:col-span-1 md:block">
          {item.year}
        </span>
      </Link>
    </motion.li>
  );
}
