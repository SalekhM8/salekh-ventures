import { cookies } from "next/headers";
import { HouseLoader } from "@/components/house3d/HouseLoader";
import { mayUseLiveHouse, SESSION_COOKIE } from "@/lib/houseAuth";

// Design prototype for sign off. It runs a sample simulation in the browser:
// no real agents, no real data. The built version reads the real event stream.
export const metadata = {
  title: "The White House (design prototype)",
  robots: { index: false, follow: false },
};

export default async function HousePage() {
  const owner = mayUseLiveHouse((await cookies()).get(SESSION_COOKIE)?.value);
  return <HouseLoader owner={owner} />;
}
