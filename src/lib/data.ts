// All site content lives here. Swap freely.

export type Work = {
  n: string;
  title: string;
  role: string;
  year: string;
  url: string;
};

// Featured projects shown on the homepage
export const works: Work[] = [
  {
    n: "01",
    title: "Vision Bank",
    role: "Digital Banking",
    year: "2025",
    url: "https://www.visionbank.com.sa",
  },
  {
    n: "02",
    title: "MOTCG",
    role: "Compliance SaaS",
    year: "2025",
    url: "https://www.motcg.co.uk",
  },
  {
    n: "03",
    title: "Dacy AI",
    role: "Restaurant Analytics",
    year: "2026",
    url: "https://www.dacy.ai",
  },
  {
    n: "04",
    title: "Nest",
    role: "Property Compliance",
    year: "2026",
    url: "https://nest28.co.uk",
  },
  {
    n: "05",
    title: "TradeLink",
    role: "Trades Marketplace",
    year: "2025",
    url: "https://www.tradelinkapp.co.uk",
  },
];

// Full archive on /work
export const allWorks: Work[] = [
  {
    n: "01",
    title: "Dacy AI",
    role: "Restaurant Analytics",
    year: "2026",
    url: "https://www.dacy.ai",
  },
  {
    n: "02",
    title: "Nest",
    role: "Property Compliance",
    year: "2026",
    url: "https://nest28.co.uk",
  },
  {
    n: "03",
    title: "Vision Bank",
    role: "Digital Banking",
    year: "2025",
    url: "https://www.visionbank.com.sa",
  },
  {
    n: "04",
    title: "MOTCG",
    role: "Compliance SaaS",
    year: "2025",
    url: "https://www.motcg.co.uk",
  },
  {
    n: "05",
    title: "TradeLink",
    role: "Trades Marketplace",
    year: "2025",
    url: "https://www.tradelinkapp.co.uk",
  },
  {
    n: "06",
    title: "Apollo Fitness",
    role: "Fitness Platform",
    year: "2025",
    url: "https://apollofitnessapp.com",
  },
  {
    n: "07",
    title: "Toasted",
    role: "iOS App",
    year: "2025",
    url: "https://apps.apple.com/gb/app/toasted/id6740433941",
  },
  {
    n: "08",
    title: "BrainBooster",
    role: "EdTech",
    year: "2025",
    url: "https://brain-booster-tau.vercel.app",
  },
  {
    n: "09",
    title: "Twilight Pharmacy",
    role: "Regulated Pharmacy",
    year: "2025",
    url: "https://www.twilightpharmacy.co.uk",
  },
  {
    n: "10",
    title: "ROOTS Pharmacy",
    role: "Regulated Pharmacy",
    year: "2025",
    url: "https://www.rootspharmacy.co.uk",
  },
  {
    n: "11",
    title: "Cloud Car Specialist",
    role: "Automotive Web",
    year: "2024",
    url: "https://www.cloudcarspecialist.com",
  },
];

export const services = [
  {
    n: "01",
    title: "Enterprise SaaS",
    desc: "Multi-tenant platforms with subscription billing, role-based access and operational dashboards your team actually uses to run the business.",
  },
  {
    n: "02",
    title: "Mobile Apps",
    desc: "Native-feel apps built with React Native and Expo. From idea to TestFlight and Play Store, with the backend that powers them built in the same sprint.",
  },
  {
    n: "03",
    title: "Web Apps",
    desc: "Production Next.js applications built for scale. TypeScript end to end, properly tested, properly deployed, properly handed over.",
  },
  {
    n: "04",
    title: "Advanced AI & Automation",
    desc: "Claude, OpenAI and bespoke AI workflows. RAG architectures, structured outputs, automations that save real hours and make the product feel intelligent.",
  },
  {
    n: "05",
    title: "Technical Strategy",
    desc: "Scoping, architecture, build sequencing. The decisions made before the first line of code that determine whether a project ships in six weeks or six months.",
  },
  {
    n: "06",
    title: "Design",
    desc: "Interface design that earns its place in production code. Clean, restrained, fast on mobile, built to support the work rather than decorate it.",
  },
];

// Testimonials — real client quotes
export const testimonials = [
  {
    quote:
      "Salekh was able to build a platform that massively exceeded our expectations. He was able to design a single site that manages all of our locations and treatments with a quick turnaround time and good response time. We have had over 500 bookings in the 1st month alone. Would recommend 👌 his services.",
    name: "Twilight Pharmacy",
    role: "Owner, Twilight Pharmacy",
  },
  {
    quote:
      "Salekh delivered exactly what we needed — a clean, fast platform that our restaurant team actually uses every day. The analytics dashboard he built has changed how we make decisions. Quick turnaround, great communication and the end product feels properly built. Highly recommend.",
    name: "Dacy AI",
    role: "Founder, Dacy AI",
  },
  {
    quote:
      "We needed a compliance platform that could handle complex workflows without feeling clunky. Salekh built it in weeks, not months. The roles, audit trails and dashboards all just work. He understood the regulatory side as quickly as the engineering side — rare to find.",
    name: "MOTCG",
    role: "Director, MOTCG",
  },
  {
    quote:
      "Salekh built our portal from scratch and the result speaks for itself. Reliable, fast, and exactly to brief. The whole engagement was fixed scope, fixed price, no surprises. He pushed back when it mattered and shipped on time. Genuinely one of the best engineers we've worked with.",
    name: "Portal365",
    role: "Co-founder, Portal365",
  },
  {
    quote:
      "Working with Salekh on Nest has been a completely different experience to past agencies. One engineer, direct line, no handoffs. He delivered a property compliance platform that landlords actually want to use. We've already had agencies ask who built it.",
    name: "Nest",
    role: "Founder, Nest",
  },
  {
    quote:
      "Salekh rebuilt our entire ordering and booking flow and the difference has been immediate. The site is faster, easier for staff and our customers comment on how clean it feels. He delivered ahead of schedule and was available throughout. Will be using him again.",
    name: "ROOTS Pharmacy",
    role: "Owner, ROOTS Pharmacy",
  },
];

// Partners marquee — uses the same project names
export const partners: { name: string; url: string }[] = [
  { name: "Vision Bank", url: "https://www.visionbank.com.sa" },
  { name: "MOTCG", url: "https://www.motcg.co.uk" },
  { name: "Dacy AI", url: "https://www.dacy.ai" },
  { name: "Toasted", url: "https://apps.apple.com/gb/app/toasted/id6740433941" },
  { name: "Nest", url: "https://nest28.co.uk" },
  { name: "TradeLink", url: "https://www.tradelinkapp.co.uk" },
  { name: "Apollo Fitness", url: "https://apollofitnessapp.com" },
  { name: "BrainBooster", url: "https://brain-booster-tau.vercel.app" },
  { name: "Twilight Pharmacy", url: "https://www.twilightpharmacy.co.uk" },
  { name: "ROOTS Pharmacy", url: "https://www.rootspharmacy.co.uk" },
  { name: "Cloud Car Specialist", url: "https://www.cloudcarspecialist.com" },
];

export const pricing = [
  {
    name: "Sprint",
    price: "From £2,000",
    desc: "A short, focused build for a single deliverable. A landing page, a critical feature, an integration, a focused tool.",
    features: [
      "1 focused deliverable",
      "2-week build sprint",
      "Async reviews and Loom updates",
      "Full source code handover",
    ],
    cta: "Enquire",
    highlight: false,
  },
  {
    name: "Build",
    price: "From £10,000",
    desc: "A complete production-ready web platform built in six weeks. The standard engagement.",
    features: [
      "Full Next.js application",
      "Auth, payments, dashboards, integrations",
      "Six-week build, fixed price, fixed scope",
      "Weekly live reviews and full code ownership",
    ],
    cta: "Most popular",
    highlight: true,
  },
  {
    name: "Partner",
    price: "From £1,000 / month",
    desc: "Ongoing engineering partnership for teams running a live product they need to keep evolving.",
    features: [
      "Dedicated hours each month",
      "Quarterly architecture reviews",
      "Direct Slack channel",
      "Priority on new feature work",
    ],
    cta: "Enquire",
    highlight: false,
  },
];

// Journal — placeholders until real articles are written.
export const journal = [
  {
    title: "Notes on the second draft",
    excerpt: "The first version is for you. The second version is for the work.",
    date: "Mar 2026",
    author: "Salekh Ventures",
  },
  {
    title: "Why we still print",
    excerpt: "The brief was digital. The proof was on paper. Here is what we learned.",
    date: "Feb 2026",
    author: "Salekh Ventures",
  },
  {
    title: "Motion as punctuation",
    excerpt: "A short essay on the small movements that hold a page together.",
    date: "Jan 2026",
    author: "Salekh Ventures",
  },
  {
    title: "A grid is a promise",
    excerpt: "On consistency, restraint, and the discipline of doing less.",
    date: "Dec 2025",
    author: "Salekh Ventures",
  },
];

export const faqs = [
  {
    q: "What do you actually build?",
    a: "Production-grade web platforms and mobile apps. Multi-tenant SaaS, digital banking, regulated healthcare software, payment-integrated marketplaces, AI-powered tools. Next.js, TypeScript, Postgres, Stripe. Built to ship, built to scale, built to hold up under real load.",
  },
  {
    q: "What is your typical turnaround time?",
    a: "Sprints are two weeks. Full Build engagements are six weeks, fixed price, fixed scope. Partner retainers run month to month. Everything is scoped before we start so the timeline is the timeline.",
  },
  {
    q: "Do you only work in Next.js?",
    a: "Mostly, yes. Next.js with TypeScript is the default because it's the fastest path from idea to production-ready software in 2026. We use Postgres for data, Clerk for auth, Stripe for payments, Vercel for hosting. Other stacks are possible but the default exists for a reason.",
  },
  {
    q: "Can you handle both design and build?",
    a: "Yes. Design, frontend, backend, infrastructure, deployment and handover, all in-house. You're working with one senior engineer, not a chain of handoffs across an agency.",
  },
  {
    q: "Do you offer technical strategy too?",
    a: "Yes. Scoping, architecture, build sequencing and decisions that shape the product before a line of code is written. Often the most valuable hours of an engagement happen before the build starts.",
  },
  {
    q: "What is your process like?",
    a: "Scope call, written spec, sign-off, build sprint, weekly review, handover. Fixed scope means fixed price. Change requests are quoted separately so the original budget always holds.",
  },
];
