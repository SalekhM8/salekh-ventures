import { Hero } from "@/components/sections/Hero";
import { About } from "@/components/sections/About";
import { Work } from "@/components/sections/Work";
import { Services } from "@/components/sections/Services";
import { Practice } from "@/components/sections/Practice";
import { Testimonials } from "@/components/sections/Testimonials";
import { Awards } from "@/components/sections/Awards";
import { Partners } from "@/components/sections/Partners";
import { Pricing } from "@/components/sections/Pricing";
import { Journal } from "@/components/sections/Journal";
import { FAQ } from "@/components/sections/FAQ";

export default function Home() {
  return (
    <>
      <Hero />
      <About />
      <Work />
      <Services />
      <Practice />
      <Testimonials />
      <Awards />
      <Partners />
      <Pricing />
      <Journal />
      <FAQ />
    </>
  );
}
