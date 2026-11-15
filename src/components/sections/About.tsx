"use client";

import { RevealText } from "@/components/ui/RevealText";
import { SectionHeader } from "./SectionHeader";

export function About() {
  return (
    <section className="border-t border-black/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© About"
        center="(WDX® — 02)"
        right="Profile"
      />
      <div className="grid grid-cols-1 gap-12 md:grid-cols-12">
        <div className="md:col-span-7">
          <RevealText
            as="h2"
            className="font-display text-4xl leading-[1.05] tracking-tight md:text-6xl"
          >
            A senior engineer with thousands of users in production. Ten years of shipping software that runs every day without breaking.
          </RevealText>
        </div>
        <div className="space-y-6 md:col-span-4 md:col-start-9">
          <p className="text-sm leading-relaxed text-muted-2">
            We work in focused six-week sprints. One senior engineer, one
            project at a time, with the depth and accountability that delivery
            actually requires.
          </p>
          <p className="text-sm leading-relaxed text-muted-2">
            The work spans digital banking, regulated pharmacy, compliance
            software, fitness platforms and SaaS for small businesses. Every
            line of code is written, reviewed and shipped under one roof.
          </p>
          <div className="grid grid-cols-2 gap-4 pt-4">
            <div>
              <p className="font-display text-3xl">10+</p>
              <p className="text-xs uppercase tracking-[0.2em] text-muted">
                Years
              </p>
            </div>
            <div>
              <p className="font-display text-3xl">1000s</p>
              <p className="text-xs uppercase tracking-[0.2em] text-muted">
                Users in production
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
