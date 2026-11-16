"use client";

import dynamic from "next/dynamic";

const House3D = dynamic(() => import("./House3D"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0B0D12] text-sm text-white/70">Building the house…</div>
  ),
});

/* The house is the demo (made up names, no connection to the runner) unless
   the page says the visitor is the signed-in owner, or this is a local dev server. */
export function HouseLoader({ owner = false }: { owner?: boolean }) {
  return <House3D demo={!owner} />;
}
