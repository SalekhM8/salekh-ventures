"use client";

import dynamic from "next/dynamic";

const House3D = dynamic(() => import("@/components/house3d/House3D"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#f6e7dd] text-sm text-black/60">Building the house…</div>
  ),
});

/** The interactive demo on the home page. A simulation: no real agents, no real data. */
export function HouseDemo() {
  return <House3D demo embedded />;
}
