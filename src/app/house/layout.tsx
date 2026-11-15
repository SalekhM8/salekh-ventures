import { fraunces } from "@/lib/fonts";

export default function HouseLayout({ children }: { children: React.ReactNode }) {
  return <div className={fraunces.variable}>{children}</div>;
}
