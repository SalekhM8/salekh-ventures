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

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={clsx(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-white/5 bg-black/60 backdrop-blur-md"
          : "bg-transparent"
      )}
    >
      <div className="flex items-center justify-between px-6 py-5 md:px-10">
        <Link
          href="/"
          className="font-display text-xl font-semibold tracking-tight"
          data-hover
        >
          Salekh Ventures<span className="text-muted">®</span>
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-muted-2 transition-colors hover:text-white"
              data-hover
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <Link
          href="/contact"
          className="hidden rounded-full border border-white/20 px-4 py-2 text-xs uppercase tracking-wider text-white transition-colors hover:border-white/60 md:inline-flex"
          data-hover
        >
          Get in touch
        </Link>
      </div>
    </header>
  );
}
