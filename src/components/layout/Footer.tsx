"use client";

import Link from "next/link";

export function Footer({ inverted = false }: { inverted?: boolean }) {
  const year = new Date().getFullYear();
  const bg = inverted ? "bg-white" : "bg-black";
  const fg = inverted ? "text-black" : "text-white";
  const muted = inverted ? "text-black/60" : "text-muted";
  const mutedStrong = inverted ? "text-black/80" : "text-white/80";
  const border = inverted ? "border-black/10" : "border-white/5";

  return (
    <footer className={`relative border-t ${border} ${bg} ${fg} px-6 pb-10 pt-24 md:px-10`}>
      <div className="mx-auto max-w-[1400px]">
        <div className="grid gap-16 md:grid-cols-12">
          <div className="md:col-span-7">
            <p className={`text-xs uppercase tracking-[0.2em] ${muted}`}>
              © Index
            </p>
            <h2 className="mt-6 font-display text-4xl leading-[0.95] tracking-tight md:text-6xl">
              Let&rsquo;s build something
              <br />
              that ships.
            </h2>
            <Link
              href="/contact"
              className={`mt-8 inline-flex items-center gap-3 text-sm uppercase tracking-[0.2em] ${fg}`}
              data-hover
            >
              <span className={`h-px w-10 ${inverted ? "bg-black" : "bg-white"}`} />
              Start a project
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-8 md:col-span-5 md:grid-cols-3">
            <div>
              <p className={`mb-4 text-xs uppercase tracking-[0.2em] ${muted}`}>
                Sitemap
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/" className={`${mutedStrong} hover:${fg}`} data-hover>
                    Home
                  </Link>
                </li>
                <li>
                  <Link href="/work" className={`${mutedStrong}`} data-hover>
                    Work
                  </Link>
                </li>
                <li>
                  <Link href="/about" className={`${mutedStrong}`} data-hover>
                    About
                  </Link>
                </li>
                <li>
                  <Link href="/journal" className={`${mutedStrong}`} data-hover>
                    Journal
                  </Link>
                </li>
                <li>
                  <Link href="/sync" className={`${mutedStrong}`} data-hover>
                    Sync
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className={`mb-4 text-xs uppercase tracking-[0.2em] ${muted}`}>
                Social
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <a href="https://www.linkedin.com/in/salekh-mahmood-73b7a21a1?utm_source=share_via&utm_content=profile&utm_medium=member_ios" target="_blank" rel="noopener noreferrer" className={mutedStrong} data-hover>
                    LinkedIn
                  </a>
                </li>
                <li>
                  <a href="https://instagram.com/salekhventures" target="_blank" rel="noopener noreferrer" className={mutedStrong} data-hover>
                    Instagram
                  </a>
                </li>
                <li>
                  <a href="https://tiktok.com/@salekhventures" target="_blank" rel="noopener noreferrer" className={mutedStrong} data-hover>
                    TikTok
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className={`mb-4 text-xs uppercase tracking-[0.2em] ${muted}`}>
                Contact
              </p>
              <ul className="space-y-2 text-sm">
                <li>
                  <a href="mailto:hello@salekhventures.com" className={mutedStrong} data-hover>
                    hello@salekhventures.com
                  </a>
                </li>
                <li>
                  <span className={mutedStrong}>UK → Anywhere</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-24 overflow-hidden">
          <div className="font-display text-[14vw] font-semibold leading-[0.85] tracking-tighter md:text-[18vw]">
            Salekh<span className={muted}>®</span>
          </div>
        </div>

        <div className={`mt-10 flex flex-col items-start justify-between gap-4 border-t ${border} pt-6 text-xs ${muted} md:flex-row md:items-center`}>
          <p>© {year} Salekh Ventures. All rights reserved.</p>
          <p>Built with intent</p>
        </div>
      </div>
    </footer>
  );
}
