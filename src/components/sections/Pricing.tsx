"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { SectionHeader } from "./SectionHeader";
import { pricing } from "@/lib/data";
import { RollButton } from "@/components/ui/RollButton";
import { clsx } from "clsx";

export function Pricing() {
  return (
    <section className="border-t border-black/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© Pricing"
        center="(WDX® — 08)"
        right="Engagements"
      />

      <h2 className="mb-20 max-w-3xl font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
        Three ways to work together. No surprises, no hourly billing.
      </h2>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
        {pricing.map((p, i) => (
          <motion.div
            key={p.name}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{
              duration: 0.7,
              delay: i * 0.1,
              ease: [0.22, 1, 0.36, 1],
            }}
            className={clsx(
              "relative flex flex-col rounded-2xl border p-8 md:p-10",
              p.highlight
                ? "border-black bg-black text-white"
                : "border-black/10 bg-surface text-black"
            )}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-2xl tracking-tight">{p.name}</h3>
              {p.highlight && (
                <span className="rounded-full bg-white px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-black">
                  Popular
                </span>
              )}
            </div>
            <p
              className={clsx(
                "mt-4 font-display text-4xl tracking-tight",
                p.highlight ? "text-white" : "text-black"
              )}
            >
              {p.price}
            </p>
            <p
              className={clsx(
                "mt-3 text-sm leading-relaxed",
                p.highlight ? "text-white/70" : "text-muted-2"
              )}
            >
              {p.desc}
            </p>

            <ul
              className={clsx(
                "mt-8 space-y-3 border-t pt-6 text-sm",
                p.highlight ? "border-white/10" : "border-black/10"
              )}
            >
              {p.features.map((f) => (
                <li key={f} className="flex items-start gap-3">
                  <span
                    className={clsx(
                      "mt-1.5 inline-block h-1 w-1 rounded-full",
                      p.highlight ? "bg-white" : "bg-black"
                    )}
                  />
                  {f}
                </li>
              ))}
            </ul>

            <div className="mt-10">
              {p.highlight ? (
                <Link
                  href="/contact"
                  className="inline-flex cursor-pointer items-center justify-center rounded-full border border-white bg-white px-6 py-3 text-sm uppercase tracking-wide text-black transition-colors duration-200 hover:bg-white/85"
                  data-hover
                >
                  {p.cta}
                </Link>
              ) : (
                <RollButton href="/contact" variant="primary" size="md">
                  {p.cta}
                </RollButton>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
