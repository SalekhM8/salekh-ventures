"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import { ContactForm } from "./ContactForm";

type Tab = "message" | "call";

export function ContactExperience() {
  const [tab, setTab] = useState<Tab>("message");

  return (
    <div>
      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Contact options"
        className="relative inline-flex rounded-full border border-black/10 bg-black/[0.03] p-1"
      >
        {[
          { id: "message" as const, label: "Send a message" },
          { id: "call" as const, label: "Book a call" },
        ].map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={clsx(
                "relative z-10 cursor-pointer rounded-full px-5 py-2 text-xs uppercase tracking-[0.15em] transition-colors",
                active ? "text-white" : "text-black/70 hover:text-black"
              )}
              data-hover
            >
              {active && (
                <motion.span
                  layoutId="contact-tab-pill"
                  className="absolute inset-0 -z-10 rounded-full bg-black"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Panel */}
      <div className="relative mt-10 min-h-[640px]">
        <AnimatePresence mode="wait">
          {tab === "message" ? (
            <motion.div
              key="message"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <ContactForm />
            </motion.div>
          ) : (
            <motion.div
              key="call"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <CalendlyPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function CalendlyPanel() {
  return (
    <div>
      <p className="mb-6 max-w-md text-sm leading-relaxed text-black/70">
        Pick a 15-minute slot that works for you. We&rsquo;ll talk through the
        idea, the scope, and whether it&rsquo;s a fit. No pressure.
      </p>

      <div className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
        <iframe
          src="https://calendly.com/salekhventures/15mins?hide_landing_page_details=1&hide_gdpr_banner=1"
          title="Book a call — Salekh Ventures"
          className="h-[700px] w-full"
          loading="lazy"
        />
      </div>

      <a
        href="https://calendly.com/salekhventures/15mins"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-block text-xs uppercase tracking-[0.2em] text-black/60 hover:text-black"
        data-hover
      >
        Open in Calendly →
      </a>
    </div>
  );
}
