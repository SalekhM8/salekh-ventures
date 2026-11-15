import { HouseLoader } from "@/components/house3d/HouseLoader";

// Design prototype for sign off. It runs a sample simulation in the browser:
// no real agents, no real data. The built version reads the real event stream.
export const metadata = {
  title: "The White House (design prototype)",
  robots: { index: false, follow: false },
};

export default function HousePage() {
  return <HouseLoader />;
}
