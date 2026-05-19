"use client";

import Link from "next/link";
import { clsx } from "clsx";

type RollButtonProps = {
  href?: string;
  onClick?: () => void;
  children: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md" | "lg";
  className?: string;
};

export function RollButton({
  href,
  onClick,
  children,
  variant = "primary",
  size = "md",
  className,
}: RollButtonProps) {
  const baseClasses = clsx(
    "inline-flex cursor-pointer items-center justify-center rounded-full border uppercase tracking-wide transition-colors duration-200",
    variant === "primary"
      ? "border-white bg-white text-black hover:bg-white/85"
      : "border-white/20 bg-transparent text-white hover:border-white hover:bg-white/5",
    size === "sm" && "px-4 py-2 text-xs",
    size === "md" && "px-6 py-3 text-sm",
    size === "lg" && "px-8 py-4 text-base",
    className
  );

  if (href) {
    return (
      <Link href={href} className={baseClasses} data-hover>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={baseClasses} data-hover>
      {children}
    </button>
  );
}
