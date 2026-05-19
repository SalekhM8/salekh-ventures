import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";

export default function DarkLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg text-fg">
      <Nav />
      <main className="relative z-10">{children}</main>
      <Footer />
    </div>
  );
}
