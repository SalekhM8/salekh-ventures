"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clsx } from "clsx";

const links = [
  { href: "/work", label: "Work" },
  { href: "/about", label: "About" },
  { href: "/journal", label: "Journal" },
  { href: "/contact", label: "Contact" },
];

export function Nav({ inverted = false }: { inverted?: boolean }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const fg = inverted ? "text-black" : "text-white";
  const muted = inverted ? "text-black/60" : "text-muted-2";
  const accent = inverted ? "text-black/50" : "text-muted";
  const border = inverted ? "border-black/10" : "border-white/5";
  const scrolledBg = inverted ? "bg-white/70" : "bg-black/60";
  const ctaBorder = inverted ? "border-black/20" : "border-white/20";
  const ctaHoverBorder = inverted ? "hover:border-black/60" : "hover:border-white/60";

  return (
    <header
      className={clsx(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled ? `border-b ${border} ${scrolledBg} backdrop-blur-md` : "bg-transparent"
      )}
    >
      <div className={clsx("flex items-center justify-between px-6 py-5 md:px-10", fg)}>
        <Link
          href="/"
          className="font-display text-xl font-semibold tracking-tight"
          data-hover
        >
          Salekh Ventures<span className={accent}>®</span>
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={clsx("text-sm transition-colors", muted, `hover:${fg}`)}
              data-hover
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <Link
          href="/contact"
          className={clsx(
            "hidden rounded-full border px-4 py-2 text-xs uppercase tracking-wider transition-colors md:inline-flex",
            ctaBorder,
            ctaHoverBorder,
            fg
          )}
          data-hover
        >
          Get in touch
        </Link>
      </div>
    </header>
  );
}
