import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
    ],
    sitemap: "https://salekhventures.com/sitemap.xml",
    host: "https://salekhventures.com",
  };
}
