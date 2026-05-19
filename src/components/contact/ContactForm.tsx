"use client";

import { useActionState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { submitContact, type ContactResult } from "@/app/actions/contact";

const budgetOptions = [
  "Under £2k",
  "£2k – £10k",
  "£10k – £25k",
  "£25k+",
  "Not sure yet",
];

export function ContactForm() {
  const [state, action, pending] = useActionState<ContactResult | null, FormData>(
    submitContact,
    null
  );

  if (state?.ok) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-2xl border border-black/10 bg-black p-10 text-white"
      >
        <p className="text-xs uppercase tracking-[0.2em] text-white/60">
          Sent
        </p>
        <h2 className="mt-4 font-display text-3xl tracking-tight md:text-4xl">
          Thanks — I&rsquo;ll be in touch shortly.
        </h2>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-white/70">
          Most replies come within one working day. If it&rsquo;s urgent, you
          can also book a 15-minute call directly.
        </p>
      </motion.div>
    );
  }

  return (
    <form action={action} className="space-y-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Field label="Name" name="name" required placeholder="Your full name" />
        <Field
          label="Email"
          name="email"
          type="email"
          required
          placeholder="you@company.com"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Field
          label="Company"
          name="company"
          placeholder="Optional"
        />
        <SelectField label="Budget" name="budget" options={budgetOptions} />
      </div>

      <TextAreaField
        label="What are you building?"
        name="message"
        required
        placeholder="A sentence or two about the project, the stage you're at, and what success looks like."
        rows={6}
      />

      <AnimatePresence>
        {state?.ok === false && (
          <motion.p
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="text-sm text-red-600"
          >
            {state.error}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="flex items-center justify-between gap-4 pt-2">
        <p className="text-xs text-black/50">
          By submitting you agree to be contacted about your enquiry.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex cursor-pointer items-center justify-center rounded-full bg-black px-7 py-3 text-sm uppercase tracking-wide text-white transition-colors hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60"
          data-hover
        >
          {pending ? "Sending…" : "Send enquiry"}
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
      <span className="mb-2 inline-block text-xs uppercase tracking-[0.15em] text-black/60">
        {label}
        {required && <span className="text-black"> *</span>}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        className="w-full border-b border-black/20 bg-transparent py-2 text-base text-black placeholder:text-black/30 focus:border-black focus:outline-none"
      />
    </label>
  );
}

function SelectField({
  label,
  name,
  options,
}: {
  label: string;
  name: string;
  options: string[];
}) {
  return (
    <label className="block">
      <span className="mb-2 inline-block text-xs uppercase tracking-[0.15em] text-black/60">
        {label}
      </span>
      <select
        name={name}
        defaultValue=""
        className="w-full cursor-pointer border-b border-black/20 bg-transparent py-2 text-base text-black focus:border-black focus:outline-none"
      >
        <option value="" disabled>
          Select a range
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
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
      <span className="mb-2 inline-block text-xs uppercase tracking-[0.15em] text-black/60">
        {label}
        {required && <span className="text-black"> *</span>}
      </span>
      <textarea
        name={name}
        required={required}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-none border-b border-black/20 bg-transparent py-2 text-base text-black placeholder:text-black/30 focus:border-black focus:outline-none"
      />
    </label>
  );
}
