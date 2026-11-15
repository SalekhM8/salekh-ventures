"use client";

import dynamic from "next/dynamic";

const House3D = dynamic(() => import("./House3D"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0B0D12] text-sm text-white/70">Building the house…</div>
  ),
});

/* On the public site the house always runs as the demo: made up business
   names and no connection to the runner. Real names and live data only show
   on a local development server. */
export function HouseLoader() {
  return <House3D demo={process.env.NODE_ENV === "production"} />;
}
