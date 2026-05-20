import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SectionHeader } from "@/components/sections/SectionHeader";
import { RollButton } from "@/components/ui/RollButton";
import { journal, type JournalBlock } from "@/lib/data";

export function generateStaticParams() {
  return journal.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;
  const post = journal.find((p) => p.slug === slug);
  if (!post) return {};
  const title = `${post.title} — Salekh Ventures`;
  return {
    title,
    description: post.excerpt,
    keywords: post.keywords,
    authors: [{ name: post.author }],
    openGraph: {
      title,
      description: post.excerpt,
      type: "article",
      publishedTime: post.dateISO,
      authors: [post.author],
      tags: post.keywords,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: post.excerpt,
    },
    alternates: {
      canonical: `https://salekhventures.com/journal/${post.slug}`,
    },
  };
}

function Block({ block }: { block: JournalBlock }) {
  if (block.type === "h2") {
    return (
      <h2 className="mt-16 font-display text-3xl leading-[1.1] tracking-tight md:text-4xl">
        {block.text}
      </h2>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="mt-6 space-y-3 text-base leading-relaxed text-white/80 md:text-lg">
        {block.items.map((item, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-2.5 inline-block h-1 w-1 shrink-0 rounded-full bg-white" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="mt-6 text-base leading-relaxed text-white/80 md:text-lg">
      {block.text}
    </p>
  );
}

export default async function JournalPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = journal.find((p) => p.slug === slug);
  if (!post) notFound();

  const idx = journal.findIndex((p) => p.slug === slug);
  const next = journal[(idx + 1) % journal.length];

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.dateISO,
    author: { "@type": "Organization", name: post.author },
    publisher: {
      "@type": "Organization",
      name: "Salekh Ventures",
      url: "https://salekhventures.com",
    },
    mainEntityOfPage: `https://salekhventures.com/journal/${post.slug}`,
    keywords: post.keywords.join(", "),
  };

  return (
    <article className="px-6 pb-24 pt-40 md:px-10 md:pb-40 md:pt-48">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <SectionHeader
        left="© Journal"
        center="(WDX® — Entry)"
        right={post.date}
      />

      <div className="mx-auto max-w-3xl">
        <Link
          href="/journal"
          className="mb-12 inline-flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-muted hover:text-white"
          data-hover
        >
          <span className="h-px w-10 bg-white/30" />
          Back to journal
        </Link>

        <h1 className="font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
          {post.title}
        </h1>
        <p className="mt-8 text-lg leading-relaxed text-white/70 md:text-xl">
          {post.excerpt}
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-white/10 py-5 text-xs uppercase tracking-[0.2em] text-muted">
          <span>{post.author}</span>
          <span>{post.date}</span>
          <span>{post.readingMinutes} min read</span>
        </div>

        <div className="mt-4">
          {post.body.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </div>

        <div className="mt-20 rounded-2xl border border-white/10 bg-surface p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.2em] text-muted">
            Working on something?
          </p>
          <h3 className="mt-4 font-display text-3xl leading-[1.1] tracking-tight md:text-4xl">
            High ticket dev work, built in six weeks.
          </h3>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-white/70">
            Senior freelance Next.js engineer in the UK. Fixed price, fixed scope,
            one engineer with the keyboard. Sprints from two weeks, full Builds
            from £10,000.
          </p>
          <div className="mt-8">
            <RollButton href="/contact" variant="primary" size="md">
              Start a project
            </RollButton>
          </div>
        </div>

        <div className="mt-20 border-t border-white/10 pt-10">
          <p className="text-xs uppercase tracking-[0.2em] text-muted">
            Next entry
          </p>
          <Link
            href={`/journal/${next.slug}`}
            className="group mt-4 flex items-center justify-between gap-6"
            data-hover
          >
            <h3 className="font-display text-2xl leading-[1.1] tracking-tight transition-transform duration-500 group-hover:translate-x-2 md:text-3xl">
              {next.title}
            </h3>
            <span className="text-xl text-muted group-hover:text-white">→</span>
          </Link>
        </div>
      </div>
    </article>
  );
}
