import { ContactExperience } from "@/components/contact/ContactExperience";

export const metadata = {
  title: "Get in touch — Salekh Ventures",
  description:
    "Software engineering from the UK's most trusted freelancer for founders who need to ship.",
};

export default function ContactPage() {
  return (
    <section className="px-6 pb-24 pt-40 md:px-10 md:pb-40 md:pt-48">
      <div className="grid grid-cols-3 items-baseline text-xs uppercase tracking-[0.2em] text-black/60">
        <span>© Get in touch</span>
        <span className="text-center">(WDX® — Contact)</span>
        <span className="text-right">Salekh Ventures</span>
      </div>

      <div className="mt-20 grid grid-cols-1 gap-12 md:grid-cols-12 md:gap-16">
        {/* Heading + tagline */}
        <div className="md:col-span-5 md:col-start-1 md:row-start-1">
          <h1 className="font-display text-5xl leading-[1] tracking-tight md:text-7xl">
            Start a project.
          </h1>
          <p className="mt-8 max-w-md text-lg leading-relaxed text-black/70">
            Software engineering from the UK&rsquo;s most trusted freelancer for
            founders who need to ship.
          </p>
        </div>

        {/* Form: on mobile sits between heading and details, on desktop spans the right column */}
        <div className="md:col-span-7 md:col-start-6 md:row-span-2 md:row-start-1">
          <ContactExperience />
        </div>

        {/* Contact details: on mobile sits below the form, on desktop under the heading */}
        <div className="space-y-6 border-t border-black/10 pt-8 md:col-span-5 md:col-start-1 md:row-start-2 md:mt-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-black/50">
              Email
            </p>
            <a
              href="mailto:hello@salekhventures.com"
              className="mt-2 inline-block text-base text-black hover:underline"
              data-hover
            >
              hello@salekhventures.com
            </a>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-black/50">
              Based in
            </p>
            <p className="mt-2 text-base">United Kingdom — working anywhere</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-black/50">
              Typical turnaround
            </p>
            <p className="mt-2 text-base">Sprints 2 weeks · Builds 6 weeks</p>
          </div>
        </div>
      </div>
    </section>
  );
}
