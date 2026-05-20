import { Hero } from "@/components/sections/Hero";
import { About } from "@/components/sections/About";
import { Work } from "@/components/sections/Work";
import { Services } from "@/components/sections/Services";
import { Practice } from "@/components/sections/Practice";
import { Testimonials } from "@/components/sections/Testimonials";
import { Partners } from "@/components/sections/Partners";
import { Pricing } from "@/components/sections/Pricing";
import { Journal } from "@/components/sections/Journal";
import { FAQ } from "@/components/sections/FAQ";
import { faqs, services, testimonials } from "@/lib/data";

const SITE = "https://salekhventures.com";

const personJsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: "Salekh Mahmood",
  url: SITE,
  jobTitle: "Senior Freelance Software Engineer",
  worksFor: { "@type": "Organization", name: "Salekh Ventures", url: SITE },
  sameAs: [
    "https://www.linkedin.com/in/salekh-mahmood-73b7a21a1",
    "https://instagram.com/salekhventures",
    "https://tiktok.com/@salekhventures",
  ],
  knowsAbout: [
    "Next.js",
    "TypeScript",
    "React",
    "Postgres",
    "Stripe",
    "Clerk",
    "AI integration",
    "SaaS engineering",
    "Fintech engineering",
  ],
  address: { "@type": "PostalAddress", addressCountry: "GB" },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "ProfessionalService",
  "@id": `${SITE}#organization`,
  name: "Salekh Ventures",
  url: SITE,
  email: "hello@salekhventures.com",
  description:
    "Senior freelance Next.js engineering studio based in the UK. High ticket dev work for founders building production SaaS, fintech and AI-integrated platforms.",
  founder: { "@type": "Person", name: "Salekh Mahmood" },
  areaServed: [
    { "@type": "Country", name: "United Kingdom" },
    { "@type": "Place", name: "Worldwide" },
  ],
  serviceType: [
    "Enterprise SaaS development",
    "Mobile app development",
    "Web application development",
    "AI integration",
    "Technical strategy",
    "UI design",
  ],
  priceRange: "££££",
  address: { "@type": "PostalAddress", addressCountry: "GB" },
  sameAs: [
    "https://www.linkedin.com/in/salekh-mahmood-73b7a21a1",
    "https://instagram.com/salekhventures",
    "https://tiktok.com/@salekhventures",
  ],
  aggregateRating: {
    "@type": "AggregateRating",
    ratingValue: "5.0",
    reviewCount: String(testimonials.length),
    bestRating: "5",
    worstRating: "1",
  },
  hasOfferCatalog: {
    "@type": "OfferCatalog",
    name: "Engineering services",
    itemListElement: services.map((s) => ({
      "@type": "Offer",
      itemOffered: { "@type": "Service", name: s.title, description: s.desc },
    })),
  },
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE}#website`,
  url: SITE,
  name: "Salekh Ventures",
  publisher: { "@id": `${SITE}#organization` },
  inLanguage: "en-GB",
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <Hero />
      <About />
      <Work />
      <Services />
      <Practice />
      <Testimonials />
      <Partners />
      <Pricing />
      <Journal />
      <FAQ />
    </>
  );
}
