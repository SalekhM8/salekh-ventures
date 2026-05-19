"use client";

import { RevealText } from "@/components/ui/RevealText";
import { SectionHeader } from "./SectionHeader";

export function About() {
  return (
    <section className="border-t border-white/5 px-6 py-24 md:px-10 md:py-40">
      <SectionHeader
        left="© About — アバウト"
        center="(WDX® — 02)"
        right="Profile"
      />
      <div className="grid grid-cols-1 gap-12 md:grid-cols-12">
        <div className="md:col-span-7">
          <RevealText
            as="h2"
            className="font-display text-4xl leading-[1.05] tracking-tight md:text-6xl"
          >
            A small studio with a steady hand. Twelve years of digital craft, sharp interactions, and a quiet kind of discipline.
          </RevealText>
        </div>
        <div className="space-y-6 md:col-span-4 md:col-start-9">
          <p className="text-sm leading-relaxed text-muted-2">
            We work in long, focused sprints with a tight group of collaborators.
            Most engagements last six to ten weeks, end to end.
          </p>
          <p className="text-sm leading-relaxed text-muted-2">
            The work is split evenly between brand systems and the websites that
            carry them. Everything is designed and built under one roof.
          </p>
          <div className="grid grid-cols-2 gap-4 pt-4">
            <div>
              <p className="font-display text-3xl">12+</p>
              <p className="text-xs uppercase tracking-[0.2em] text-muted">
                Years
              </p>
            </div>
            <div>
              <p className="font-display text-3xl">80+</p>
              <p className="text-xs uppercase tracking-[0.2em] text-muted">
                Projects
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
