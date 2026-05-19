"use client";

import { motion, useInView } from "framer-motion";
import { useRef, Children, isValidElement } from "react";
import { clsx } from "clsx";

type RevealTextProps = {
  children: React.ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div";
  delay?: number;
  stagger?: number;
  once?: boolean;
};

/**
 * Wraps children in a clip-path mask and translates them up from below
 * on enter. If children is a string, it splits by spaces and staggers each word.
 */
export function RevealText({
  children,
  className,
  as: Tag = "div",
  delay = 0,
  stagger = 0.06,
  once = true,
}: RevealTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once, amount: 0.2 });

  const renderContent = () => {
    if (typeof children === "string") {
      const words = children.split(" ");
      return words.map((word, i) => (
        <span key={i} className="inline-flex overflow-hidden align-baseline">
          <motion.span
            initial={{ y: "110%" }}
            animate={inView ? { y: "0%" } : { y: "110%" }}
            transition={{
              duration: 0.85,
              delay: delay + i * stagger,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="inline-block"
          >
            {word}
            {i < words.length - 1 ? "\u00A0" : ""}
          </motion.span>
        </span>
      ));
    }

    return (
      <span className="inline-flex overflow-hidden align-baseline">
        <motion.span
          initial={{ y: "110%" }}
          animate={inView ? { y: "0%" } : { y: "110%" }}
          transition={{ duration: 0.85, delay, ease: [0.22, 1, 0.36, 1] }}
          className="inline-block"
        >
          {children}
        </motion.span>
      </span>
    );
  };

  const Component = motion[Tag] as typeof motion.div;
  return (
    <Component ref={ref} className={clsx(className)}>
      {renderContent()}
    </Component>
  );
}
