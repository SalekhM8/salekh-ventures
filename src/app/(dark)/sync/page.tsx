import type { Metadata } from "next";
import { SyncLanding } from "@/components/sync/SyncLanding";

export const metadata: Metadata = {
  title: "Multichannel Sync for Amazon, eBay & TikTok Shop",
  description:
    "Stock, prices and listings managed in one place and synced to Amazon, eBay and TikTok Shop in seconds. No Shopify required. £399 done-for-you setup, £29/month locked.",
  alternates: { canonical: "/sync" },
  openGraph: {
    title: "Multichannel Sync for Amazon, eBay & TikTok Shop",
    description:
      "Run Amazon, eBay and TikTok Shop from one platform. Stock synced in seconds, listings written per channel, real margin per SKU after fees.",
    url: "https://salekhventures.com/sync",
  },
};

export default function SyncPage() {
  return <SyncLanding />;
}
