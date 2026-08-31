"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { submitSyncLead, type SyncLeadResult } from "@/app/actions/syncLead";

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

const platformOptions = [
  "Amazon",
  "eBay",
  "TikTok Shop",
  "Etsy",
  "My own website",
  "Other",
];

const productOptions = ["Under 100", "100 to 1,000", "Over 1,000"];

const stockOptions = [
  "By hand / spreadsheets",
  "A sync tool already",
  "Shopify plus apps",
  "I don't — it's a mess",
];

const profitOptions = ["Yes, exactly", "Roughly", "Honestly, no"];

export function SyncForm() {
  const [state, formAction, pending] = useActionState<
    SyncLeadResult | null,
    FormData
  >(submitSyncLead, null);

  // One eventId per form lifecycle, shared between the browser pixel event
  // and the server-side CAPI event so Meta deduplicates them.
  const eventIdRef = useRef<string>("");
  const firedRef = useRef(false);

  const confirmationRef = useRef<HTMLDivElement>(null);

  // Carry ad attribution (utm_* / fbclid from Meta) into the submission.
  // Remembered in localStorage so a return visit days later still credits
  // the ad that first brought them here.
  const [utm, setUtm] = useState("");
  useEffect(() => {
    try {
      const search = window.location.search.slice(1);
      if (/(?:^|&)(utm_|fbclid)/.test(search)) {
        localStorage.setItem("sv_attribution", search);
        setUtm(search);
      } else {
        setUtm(localStorage.getItem("sv_attribution") || search);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (state?.ok && !firedRef.current) {
      firedRef.current = true;
      window.fbq?.("track", "Lead", {}, { eventID: state.eventId });
      confirmationRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [state]);

  if (state?.ok) {
    return (
      <motion.div
        ref={confirmationRef}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-2xl border border-white/10 bg-surface p-10 scroll-mt-32"
      >
        <p className="text-xs uppercase tracking-[0.2em] text-muted">Sent</p>
        <h3 className="mt-4 font-display text-3xl tracking-tight md:text-4xl">
          Got it. I&rsquo;ll come back to you today.
        </h3>
      </motion.div>
    );
  }

  return (
    <form
      action={(formData) => {
        if (!eventIdRef.current) eventIdRef.current = crypto.randomUUID();
        formData.set("eventId", eventIdRef.current);
        formAction(formData);
      }}
      className="space-y-8"
    >
      <input type="hidden" name="utm" value={utm} readOnly />
      <fieldset>
        <legend className="mb-3 text-xs uppercase tracking-[0.15em] text-muted">
          Which platforms do you currently sell on?{" "}
          <span className="text-white">*</span>
        </legend>
        <div className="flex flex-wrap gap-3">
          {platformOptions.map((p) => (
            <label
              key={p}
              className="group flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm transition-colors has-checked:border-white has-checked:bg-white has-checked:text-black"
              data-hover
            >
              <input
                type="checkbox"
                name="platforms"
                value={p}
                className="sr-only"
              />
              {p}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-xs uppercase tracking-[0.15em] text-muted">
          Roughly how many products do you list?{" "}
          <span className="text-white">*</span>
        </legend>
        <div className="flex flex-wrap gap-3">
          {productOptions.map((o) => (
            <label
              key={o}
              className="flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm transition-colors has-checked:border-white has-checked:bg-white has-checked:text-black"
              data-hover
            >
              <input
                type="radio"
                name="products"
                value={o}
                required
                className="sr-only"
              />
              {o}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-xs uppercase tracking-[0.15em] text-muted">
          How do you keep stock matching across platforms right now?{" "}
          <span className="text-white">*</span>
        </legend>
        <div className="flex flex-wrap gap-3">
          {stockOptions.map((o) => (
            <label
              key={o}
              className="flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm transition-colors has-checked:border-white has-checked:bg-white has-checked:text-black"
              data-hover
            >
              <input
                type="radio"
                name="stock"
                value={o}
                required
                className="sr-only"
              />
              {o}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-xs uppercase tracking-[0.15em] text-muted">
          Do you know your profit per product after each platform&rsquo;s fees?{" "}
          <span className="text-white">*</span>
        </legend>
        <div className="flex flex-wrap gap-3">
          {profitOptions.map((o) => (
            <label
              key={o}
              className="flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm transition-colors has-checked:border-white has-checked:bg-white has-checked:text-black"
              data-hover
            >
              <input
                type="radio"
                name="pricing"
                value={o}
                required
                className="sr-only"
              />
              {o}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Field label="Name" name="name" required placeholder="Your full name" />
        <Field
          label="Email"
          name="email"
          type="email"
          required
          placeholder="you@company.com"
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          required
          placeholder="07…"
        />
      </div>

      <AnimatePresence>
        {state?.ok === false && (
          <motion.p
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="text-sm text-red-400"
          >
            {state.error}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-4 pt-2 md:flex-row md:items-center md:justify-between">
        <p className="text-xs leading-relaxed text-muted">
          No payment, no commitment. I read every reply personally and come
          back the same day — just to see if it fits your setup.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-white px-7 py-3 text-sm uppercase tracking-wide text-black transition-colors hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60"
          data-hover
        >
          {pending ? "Sending…" : "Send it over"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 inline-block text-xs uppercase tracking-[0.15em] text-muted">
        {label}
        {required && <span className="text-white"> *</span>}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        className="w-full border-b border-white/20 bg-transparent py-2 text-base text-white placeholder:text-white/30 focus:border-white focus:outline-none"
      />
    </label>
  );
}
