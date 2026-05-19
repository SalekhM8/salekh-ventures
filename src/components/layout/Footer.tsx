"use client";

import Link from "next/link";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative border-t border-white/5 bg-black px-6 pb-10 pt-24 md:px-10">
      <div className="mx-auto max-w-[1400px]">
        <div className="grid gap-16 md:grid-cols-12">
          <div className="md:col-span-7">
            <p className="text-xs uppercase tracking-[0.2em] text-muted">
              © Index — フッター
            </p>
            <h2 className="mt-6 font-display text-4xl leading-[0.95] tracking-tight md:text-6xl">
              Let&rsquo;s build something
              <br />
              worth remembering.
            </h2>
            <Link
              href="/contact"
              className="mt-8 inline-flex items-center gap-3 text-sm uppercase tracking-[0.2em] text-white"
              data-hover
            >
              <span className="h-px w-10 bg-white" />
              Start a project
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-8 md:col-span-5 md:grid-cols-3">
            <div>
              <p className="mb-4 text-xs uppercase tracking-[0.2em] text-muted">
                Sitemap
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/" className="text-white/80 hover:text-white" data-hover>
                    Home
                  </Link>
                </li>
                <li>
                  <Link href="/work" className="text-white/80 hover:text-white" data-hover>
                    Work
                  </Link>
                </li>
                <li>
                  <Link href="/about" className="text-white/80 hover:text-white" data-hover>
                    About
                  </Link>
                </li>
                <li>
                  <Link href="/journal" className="text-white/80 hover:text-white" data-hover>
                    Journal
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-4 text-xs uppercase tracking-[0.2em] text-muted">
                Social
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <a href="#" className="text-white/80 hover:text-white" data-hover>
                    Instagram
                  </a>
                </li>
                <li>
                  <a href="#" className="text-white/80 hover:text-white" data-hover>
                    Dribbble
                  </a>
                </li>
                <li>
                  <a href="#" className="text-white/80 hover:text-white" data-hover>
                    LinkedIn
                  </a>
                </li>
                <li>
                  <a href="#" className="text-white/80 hover:text-white" data-hover>
                    Are.na
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-4 text-xs uppercase tracking-[0.2em] text-muted">
                Contact
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <a href="mailto:hello@studio.com" className="text-white/80 hover:text-white" data-hover>
                    hello@studio.com
                  </a>
                </li>
                <li>
                  <span className="text-white/80">London → Anywhere</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-24 overflow-hidden">
          <div className="font-display text-[14vw] font-semibold leading-[0.85] tracking-tighter md:text-[18vw]">
            Salekh<span className="text-muted">®</span>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-4 border-t border-white/5 pt-6 text-xs text-muted md:flex-row md:items-center">
          <p>© {year} Salekh Ventures. All rights reserved.</p>
          <p>Crafted with intent — クラフト</p>
        </div>
      </div>
    </footer>
  );
}
