import { Fraunces } from "next/font/google";

/* Used by the White House (the house page and the demo on the home page). */
export const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["300", "400"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});
