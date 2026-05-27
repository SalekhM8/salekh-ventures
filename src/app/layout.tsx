import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { LenisProvider } from "@/components/providers/LenisProvider";
import { Cursor } from "@/components/ui/Cursor";

const META_PIXEL_ID = "1281250857508098";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const interDisplay = Inter({
  variable: "--font-inter-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://salekhventures.com"),
  title: {
    default: "Senior Freelance Next.js Developer UK — Salekh Ventures",
    template: "%s | Salekh Ventures",
  },
  description:
    "High ticket dev work in the UK. Senior freelance Next.js engineer building production SaaS, fintech and AI-integrated platforms for founders who need to ship. Fixed price, fixed scope, six week builds.",
  keywords: [
    "senior freelance Next.js developer UK",
    "high ticket developer UK",
    "freelance software engineer London",
    "SaaS developer UK",
    "MVP developer UK",
    "fixed price web development UK",
    "Next.js TypeScript engineer",
    "AI integration developer UK",
    "Stripe Clerk Next.js",
    "fintech developer UK",
  ],
  authors: [{ name: "Salekh Mahmood", url: "https://salekhventures.com" }],
  creator: "Salekh Mahmood",
  publisher: "Salekh Ventures",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_GB",
    url: "https://salekhventures.com",
    siteName: "Salekh Ventures",
    title: "Senior Freelance Next.js Developer UK — Salekh Ventures",
    description:
      "High ticket dev work in the UK. Production SaaS, fintech and AI-integrated platforms built in six weeks.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Senior Freelance Next.js Developer UK — Salekh Ventures",
    description:
      "High ticket dev work in the UK. Production SaaS, fintech and AI builds in six weeks.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  category: "Software Engineering",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${interDisplay.variable} antialiased`}
    >
      <body className="min-h-screen">
        <Script id="meta-pixel" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${META_PIXEL_ID}');
            fbq('track', 'PageView');
          `}
        </Script>
        <noscript>
          <img
            height="1"
            width="1"
            style={{ display: "none" }}
            src={`https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1`}
            alt=""
          />
        </noscript>
        <LenisProvider>
          <Cursor />
          {children}
        </LenisProvider>
      </body>
    </html>
  );
}
