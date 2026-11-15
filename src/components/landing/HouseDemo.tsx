"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const House3D = dynamic(() => import("@/components/house3d/House3D"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#f6e7dd] text-sm text-black/60">Building the house…</div>
  ),
});

/** The interactive demo on the home page. A simulation: no real agents, no real data.
 *
 *  On a computer it is used in place. On a phone it shows as a slowly turning
 *  poster that does not capture swipes, so the page still scrolls; tapping it
 *  opens the house full screen. It stops drawing while it is off screen. */
export function HouseDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [phone, setPhone] = useState(false);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const set = () => setPhone(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.dataset.overlay = "house";
    return () => {
      document.body.style.overflow = prev;
      delete document.documentElement.dataset.overlay;
    };
  }, [open]);

  const full = phone && open;
  return (
    <div ref={ref} className="relative h-full w-full">
      <div data-lenis-prevent={full ? true : undefined} className={full ? "fixed inset-0 z-[80] bg-[#f6e7dd]" : "relative h-full w-full"}>
        <House3D demo embedded preview={phone && !open} lowPower={phone} paused={!visible && !full} onClose={full ? () => setOpen(false) : undefined} />
        {phone && !open && (
          <button type="button" onClick={() => setOpen(true)} className="absolute inset-0 flex items-end justify-center pb-5" aria-label="Open the house full screen">
            <span className="rounded-full bg-black px-6 py-4 text-base font-semibold text-white shadow-lg">Tap to walk inside</span>
          </button>
        )}
      </div>
    </div>
  );
}
