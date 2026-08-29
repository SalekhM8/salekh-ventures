"use client";

import { useActionState, useEffect, useRef } from "react";
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

export function SyncForm() {
  const [state, formAction, pending] = useActionState<
    SyncLeadResult | null,
    FormData
  >(submitSyncLead, null);

  // One eventId per form lifecycle, shared between the browser pixel event
  // and the server-side CAPI event so Meta deduplicates them.
  const eventIdRef = useRef<string>("");
  const firedRef = useRef(false);

  useEffect(() => {
    if (state?.ok && !firedRef.current) {
      firedRef.current = true;
      window.fbq?.("track", "Lead", {}, { eventID: state.eventId });
    }
  }, [state]);

  if (state?.ok) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-2xl border border-white/10 bg-surface p-10"
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

      <TextAreaField
        label="How do you keep stock and prices matching across platforms right now?"
        name="stock"
        required
        placeholder="Spreadsheets, a sync tool, doing it by hand at night — whatever it actually is."
        rows={3}
      />

      <TextAreaField
        label="How do you decide your prices, and do you know your actual profit per product on each platform after fees? (optional)"
        name="pricing"
        placeholder="Honest answer — most sellers don't know this per channel."
        rows={3}
      />

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

      <div className="flex items-center justify-between gap-4 pt-2">
        <p className="text-xs text-muted">
          By submitting you agree to be contacted about your enquiry.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex cursor-pointer items-center justify-center rounded-full bg-white px-7 py-3 text-sm uppercase tracking-wide text-black transition-colors hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60"
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

function TextAreaField({
  label,
  name,
  required = false,
  placeholder,
  rows = 4,
}: {
  label: string;
  name: string;
  required?: boolean;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="mb-2 inline-block text-xs uppercase tracking-[0.15em] text-muted">
        {label}
        {required && <span className="text-white"> *</span>}
      </span>
      <textarea
        name={name}
        required={required}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-none border-b border-white/20 bg-transparent py-2 text-base text-white placeholder:text-white/30 focus:border-white focus:outline-none"
      />
    </label>
  );
}
