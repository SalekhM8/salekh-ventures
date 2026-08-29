import type { MetadataRoute } from "next";
import { journal } from "@/lib/data";

const SITE = "https://salekhventures.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${SITE}/work`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE}/journal`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE}/contact`, lastModified: now, changeFrequency: "yearly", priority: 0.7 },
    { url: `${SITE}/sync`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
  ];

  const journalRoutes: MetadataRoute.Sitemap = journal.map((p) => ({
    url: `${SITE}/journal/${p.slug}`,
    lastModified: new Date(p.dateISO),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [...staticRoutes, ...journalRoutes];
}
