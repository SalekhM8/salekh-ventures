"use client";

import { useEffect, useRef } from "react";
import { clsx } from "clsx";

type MarqueeProps = {
  children: React.ReactNode;
  direction?: "left" | "right";
  speed?: number; // seconds per loop
  className?: string;
};

export function Marquee({
  children,
  direction = "left",
  speed = 40,
  className,
}: MarqueeProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--marquee-duration", `${speed}s`);
    el.style.setProperty(
      "--marquee-direction",
      direction === "left" ? "normal" : "reverse"
    );
  }, [direction, speed]);

  return (
    <div ref={ref} className={clsx("relative overflow-hidden", className)}>
      <div className="flex w-max animate-[marquee_var(--marquee-duration,40s)_linear_infinite] [animation-direction:var(--marquee-direction,normal)]">
        <div className="flex shrink-0 items-center gap-16 pr-16">{children}</div>
        <div className="flex shrink-0 items-center gap-16 pr-16" aria-hidden>
          {children}
        </div>
      </div>
      <style jsx>{`
        @keyframes marquee {
          from {
            transform: translateX(0);
          }
          to {
            transform: translateX(-50%);
          }
        }
      `}</style>
    </div>
  );
}
