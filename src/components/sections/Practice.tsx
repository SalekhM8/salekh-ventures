"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";

export function Practice() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    // 0 when section top hits bottom of viewport,
    // 1 when section center hits viewport center.
    offset: ["start end", "center center"],
  });

  const scale = useTransform(scrollYProgress, [0, 1], [0.35, 1]);
  const tracking = useTransform(scrollYProgress, [0, 1], ["-0.05em", "0em"]);
  const opacity = useTransform(scrollYProgress, [0, 0.3, 1], [0.15, 0.6, 1]);

  return (
    <section
      ref={ref}
      className="relative border-t border-black/5 px-6 py-32 md:px-10 md:py-56"
    >
      <div className="grid grid-cols-3 items-baseline text-xs uppercase tracking-[0.2em] text-muted">
        <span>© Practice</span>
        <span className="text-center">(WDX® — 05)</span>
        <span className="text-right">Experience</span>
      </div>

      <div className="my-24 flex items-center justify-center overflow-hidden md:my-40">
        <motion.h2
          style={{ scale, letterSpacing: tracking, opacity }}
          className="origin-center font-display text-[20vw] font-semibold uppercase leading-none will-change-transform"
        >
          Practice
        </motion.h2>
      </div>

      <p className="mx-auto max-w-2xl text-center text-base leading-relaxed text-muted-2 md:text-lg">
        The work is built on a small set of habits. Scope before coding. Ship
        before polishing. Review every line that touches production. Repeated
        until they become invisible.
      </p>
    </section>
  );
}
