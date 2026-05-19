import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";

export default function LightLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white text-black">
      <Nav inverted />
      <main className="relative z-10">{children}</main>
      <Footer inverted />
    </div>
  );
}
