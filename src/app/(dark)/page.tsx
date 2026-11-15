import { Landing } from "@/components/landing/Landing";

const SITE = "https://salekhventures.com";

export const metadata = {
  title: { absolute: "AI departments that run your business | Salekh Ventures" },
  description:
    "Salekh Ventures builds and trains a team of AI agents for your business, one per department. They do the day to day. You set the targets, approve the big calls and score the work. Ten clients.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "en_GB",
    url: SITE,
    siteName: "Salekh Ventures",
    title: "AI departments that run your business. You stay president.",
    description: "A team of AI agents, one per department, built and trained for your business. Try the interactive house.",
  },
};

const personJsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: "Salekh Mahmood",
  url: SITE,
  worksFor: { "@type": "Organization", name: "Salekh Ventures", url: SITE },
  sameAs: [
    "https://www.linkedin.com/in/salekh-mahmood-73b7a21a1",
    "https://instagram.com/salekhventures",
    "https://tiktok.com/@salekhventures",
  ],
  address: { "@type": "PostalAddress", addressCountry: "GB" },
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Salekh Ventures",
  url: SITE,
};

export default function HomePage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }} />
      <Landing />
    </>
  );
}
