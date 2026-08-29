"use client";

import { motion } from "framer-motion";
import { SectionHeader } from "@/components/sections/SectionHeader";
import { SyncForm } from "./SyncForm";

const EASE = [0.22, 1, 0.36, 1] as const;

const platforms = [
  { name: "Amazon", logo: "/logos/amazon.svg" },
  { name: "eBay", logo: "/logos/ebay.svg" },
  { name: "TikTok Shop", logo: "/logos/tiktok.svg" },
  { name: "Etsy", logo: "/logos/etsy.svg" },
];

const features = [
  {
    n: "01",
    title: "Stock sync in both directions",
    desc: "Something sells on eBay — Amazon and TikTok know immediately. You restock and every platform updates. No oversells, no refunds, no account health strikes, no updating three dashboards at 11pm.",
  },
  {
    n: "02",
    title: "No Shopify required",
    desc: "Your catalog lives in the platform itself. If you currently pay for an empty Shopify store just to make a sync tool work, cancel it.",
  },
  {
    n: "03",
    title: "Sync you can see",
    desc: "Live health status for every channel, a full log of every change with timestamps, and an instant alert if anything fails to push. If something breaks you know within minutes, not when a customer complains.",
  },
  {
    n: "04",
    title: "Listings written for each platform",
    desc: "Add a product once and it generates channel-ready listings: keyword-optimised titles and bullets for Amazon, item specifics for eBay, hook-style titles for TikTok. One product in, three native listings out.",
  },
  {
    n: "05",
    title: "An AI analyst that works without being asked",
    desc: "It watches your sales, fees and competitors and tells you what needs attention: this SKU is being undercut on Amazon, this product lost money on TikTok last week after commission, this price rise on eBay wouldn't cost you sales. It knows your real margin per SKU per channel after every platform's fees, warns you before any price change takes a sale below profit, and flags opportunities when it spots them. You don't dig through reports — it comes to you.",
  },
];

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function SyncLanding() {
  return (
    <>
      {/* Hero */}
      <section className="px-6 pt-40 pb-24 md:px-10 md:pt-52 md:pb-32">
        <SectionHeader left="© Sync" center="(SV® — Sync)" right="Multichannel" />
        <motion.h1
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="max-w-5xl font-display text-4xl leading-[1.05] tracking-tight md:text-7xl"
        >
          Sell on Amazon, eBay and TikTok Shop? Run it all from one platform.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.15, ease: EASE }}
          className="mt-8 max-w-2xl text-lg leading-relaxed text-muted-2 md:text-xl"
        >
          Stock, prices and listings managed in one place and synced to every
          channel in seconds — not on a 15-minute timer.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.25, ease: EASE }}
          className="mt-10"
        >
          <a
            href="#apply"
            className="inline-flex cursor-pointer items-center justify-center rounded-full bg-white px-7 py-3 text-sm uppercase tracking-wide text-black transition-colors hover:bg-white/85"
            data-hover
          >
            See if it fits your setup
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4, ease: EASE }}
          className="mt-20 border-t border-white/10 pt-8 md:mt-24"
        >
          <p className="mb-6 text-xs uppercase tracking-[0.2em] text-muted">
            Syncs with
          </p>
          <div className="flex flex-wrap items-center gap-x-10 gap-y-6 md:gap-x-14">
            {platforms.map((p) => (
              <span key={p.name} className="flex items-center gap-3 opacity-80">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.logo} alt={p.name} className="h-6 w-6 md:h-7 md:w-7" />
                <span className="text-sm font-medium tracking-wide text-white md:text-base">
                  {p.name}
                </span>
              </span>
            ))}
          </div>
        </motion.div>
      </section>

      {/* What it does */}
      <section className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
        <SectionHeader left="© Features" center="(SV® — 01)" right="What it does" />
        <Reveal>
          <h2 className="mb-20 max-w-3xl font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
            What it does
          </h2>
        </Reveal>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          {features.map((f, i) => (
            <Reveal
              key={f.n}
              delay={i * 0.08}
              className={
                f.n === "05"
                  ? "rounded-2xl border border-white/10 bg-surface p-8 md:col-span-2 md:p-10"
                  : "rounded-2xl border border-white/10 bg-surface p-8 md:p-10"
              }
            >
              <span className="text-xs uppercase tracking-[0.2em] text-muted">
                {f.n}
              </span>
              <h3 className="mt-4 font-display text-2xl tracking-tight md:text-3xl">
                {f.title}
              </h3>
              <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-2 md:text-base">
                {f.desc}
              </p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* What it costs */}
      <section id="pricing" className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
        <SectionHeader left="© Pricing" center="(SV® — 02)" right="What it costs" />
        <Reveal>
          <div className="mx-auto max-w-3xl rounded-2xl border border-white bg-white p-8 text-black md:p-14">
            <p className="text-xs uppercase tracking-[0.2em] text-black/50">
              What it costs
            </p>
            <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <span className="font-display text-5xl tracking-tight md:text-6xl">
                £399
              </span>
              <span className="text-base text-black/60">setup, done for you</span>
            </div>
            <p className="mt-5 text-sm leading-relaxed text-black/70 md:text-base">
              I migrate your full catalog, connect every channel, map your
              listings and verify stock across platforms before going live. You
              touch nothing technical.
            </p>
            <div className="mt-8 flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-black/10 pt-8">
              <span className="font-display text-4xl tracking-tight md:text-5xl">
                £29<span className="text-xl text-black/50"> /month</span>
              </span>
              <span className="text-base text-black/60">
                locked at that rate permanently, cancel anytime
              </span>
            </div>
            <p className="mt-8 rounded-xl bg-black px-5 py-4 text-sm leading-relaxed text-white md:text-base">
              If you&rsquo;re not live within 14 days, the £399 comes back.
            </p>
            <p className="mt-6 text-sm leading-relaxed text-black/60 md:text-base">
              For less than an empty Shopify store plus a sync tool — and the
              sync actually works.
            </p>
          </div>
        </Reveal>
      </section>

      {/* Who's behind it */}
      <section className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
        <SectionHeader left="© About" center="(SV® — 03)" right="Who's behind it" />
        <Reveal>
          <h2 className="max-w-3xl font-display text-3xl leading-[1.15] tracking-tight md:text-5xl">
            I&rsquo;m Salekh. I build software for regulated businesses —
            pharmacies, payment companies and care providers.
          </h2>
          <p className="mt-8 max-w-2xl text-base leading-relaxed text-muted-2 md:text-lg">
            I build your setup myself and you deal with me directly, not a
            support queue.
          </p>
        </Reveal>
      </section>

      {/* Form */}
      <section id="apply" className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
        <SectionHeader left="© Apply" center="(SV® — 04)" right="Same-day reply" />
        <Reveal>
          <h2 className="mb-6 max-w-3xl font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
            See if it fits your setup
          </h2>
          <p className="mb-16 max-w-2xl text-base leading-relaxed text-muted-2 md:text-lg">
            Fill out the form and I&rsquo;ll come back to you the same day.
          </p>
        </Reveal>
        <div className="max-w-3xl">
          <SyncForm />
        </div>
      </section>
    </>
  );
}
