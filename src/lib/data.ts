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
      "Honestly couldn't be happier with the work. Salekh got our analytics dashboard up and running in a few weeks and the team uses it every single shift. He just gets what we needed without us having to spell it all out. Easy to work with and properly fast. Big recommend.",
    name: "Dacy AI",
    role: "Founder, Dacy AI",
  },
  {
    quote:
      "We came to Salekh with a pretty complex set of compliance workflows and a tight deadline. He turned it around quicker than anyone else we spoke to and the platform just works the way we need it to. No fuss, no missed deadlines, no surprises on the invoice. Will be using him again.",
    name: "MOTCG",
    role: "Director, MOTCG",
  },
  {
    quote:
      "Top guy. Built our portal from scratch and was always on hand when we had a question. Felt like we had our own engineer on the team rather than dealing with an agency. Hit the timeline he gave us and the platform has been running smoothly since day one.",
    name: "Portal365",
    role: "Co-founder, Portal365",
  },
  {
    quote:
      "Working with Salekh has been so much easier than the agencies we'd tried before. One guy, one slack channel, things actually getting done. The landlords using our platform tell us how simple it feels and that came straight from how he built it. 10/10.",
    name: "Nest",
    role: "Founder, Nest",
  },
  {
    quote:
      "Salekh rebuilt our site and the difference is night and day. Staff find it easier, customers find it easier and our bookings have gone up since launch. Any time we needed a tweak he came back quickly and got it sorted. Really pleased with how it turned out.",
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

// Journal — long-form notes on building production software for UK founders.
export type JournalBlock =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] };

export type JournalPost = {
  slug: string;
  title: string;
  excerpt: string;
  date: string;
  dateISO: string;
  author: string;
  readingMinutes: number;
  keywords: string[];
  body: JournalBlock[];
};

export const journal: JournalPost[] = [
  {
    slug: "how-i-price-ten-thousand-pound-builds",
    title: "How I price £10,000 builds (and why founders keep paying it)",
    excerpt:
      "Pricing high ticket dev work in the UK is not about hours. It is about outcomes, speed and the cost of getting it wrong twice.",
    date: "Apr 2026",
    dateISO: "2026-04-08",
    author: "Salekh Ventures",
    readingMinutes: 6,
    keywords: [
      "high ticket developer UK",
      "freelance Next.js developer UK",
      "value based pricing software",
      "senior freelance engineer London",
      "fixed price web development UK",
      "SaaS developer UK",
    ],
    body: [
      {
        type: "p",
        text: "Most founders who land on my pricing page do a small double take at the £10,000 number. That is the point. High ticket dev work in the UK should make you pause, because the alternative is a £40k agency invoice with three project managers attached, or a £15/hour Upwork contractor who disappears in week two with half a checkout flow.",
      },
      {
        type: "p",
        text: "Here is how I actually think about pricing.",
      },
      {
        type: "h2",
        text: "Hours are a terrible unit",
      },
      {
        type: "p",
        text: "If I bill you by the hour, we both lose. You start counting minutes. I start padding tasks. The fastest engineer on earth gets punished for being fast. Senior freelance Next.js developers in the UK who still bill hourly are basically apologising for being good.",
      },
      {
        type: "p",
        text: "Fixed price means I am paid for the result. If I ship the platform in three weeks instead of six, that is my problem to solve and your problem to celebrate. You get a working product. I get a free week to read a book. Everyone wins.",
      },
      {
        type: "h2",
        text: "What you are actually paying for",
      },
      {
        type: "ul",
        items: [
          "Senior decisions, made fast, that survive a year of real users hitting them",
          "A stack you can actually hire into later (Next.js, TypeScript, Postgres, Stripe, Clerk, Vercel)",
          "Six weeks of focused build time on a fixed scope I will not let drift",
          "Zero handoffs, zero project managers, zero account managers, one engineer with the keyboard",
          "A product that ships, on a date you can put in a deck",
        ],
      },
      {
        type: "h2",
        text: "Why agencies cost three times more",
      },
      {
        type: "p",
        text: "A London product agency charging £30k is paying for an account manager, a PM, a creative director, a strategist, two junior devs and an office in Shoreditch with a tap nobody uses. You get a deck full of personas before anyone touches a Figma. Founders who need to ship in 2026 cannot afford that org chart.",
      },
      {
        type: "p",
        text: "Solo senior engineers in the UK are eating the agency lunch for one reason. We can build the thing in the time the agency takes to write a kickoff doc.",
      },
      {
        type: "h2",
        text: "When £10,000 is the wrong number",
      },
      {
        type: "p",
        text: "If your build is a landing page and a Stripe checkout, you do not need a £10k engagement. You need a Sprint. Two weeks, focused, in and out, and I send you back to your day job. If your build is a multi tenant SaaS with auth, dashboards, billing, integrations and an AI feature, then £10k is the right number because the cost of doing it twice is closer to £40k.",
      },
      {
        type: "p",
        text: "The job of pricing is to make this decision easy. Three tiers, no hourly billing, no surprises. Pick one, sign one page, we start Monday.",
      },
      {
        type: "h2",
        text: "Bottom line",
      },
      {
        type: "p",
        text: "If you are a UK founder weighing up agencies, dev shops and solo seniors, the question is never the rate. It is who can actually ship the product. £10,000 buys a senior engineer for six weeks with skin in the game. That is the cheapest path to production software you will find this year.",
      },
    ],
  },
  {
    slug: "freelance-dev-vs-london-agency",
    title: "One senior freelance Next.js dev or a London agency? Read this first",
    excerpt:
      "Choosing between a solo senior engineer and a UK product agency comes down to who actually writes the code at 11pm on a Thursday.",
    date: "Mar 2026",
    dateISO: "2026-03-12",
    author: "Salekh Ventures",
    readingMinutes: 5,
    keywords: [
      "freelance Next.js developer UK",
      "London product agency vs freelancer",
      "senior software engineer UK",
      "MVP developer UK",
      "hire freelance developer London",
      "high ticket developer UK",
    ],
    body: [
      {
        type: "p",
        text: "Every couple of weeks a founder messages me asking the same thing. Should I go with a London agency or a senior freelance Next.js developer in the UK. Here is the honest answer I give them.",
      },
      {
        type: "h2",
        text: "The agency math nobody shows you",
      },
      {
        type: "p",
        text: "A typical UK product agency quote for a Build like mine sits between £30,000 and £80,000. For that you get a team. Sounds great until you ask who is actually writing the code. Usually a mid weight engineer with two years of experience, two other clients on their plate, and a PM filtering every question through Slack so the senior architect does not get bothered.",
      },
      {
        type: "p",
        text: "You are paying senior rates for junior output. That is the entire agency model.",
      },
      {
        type: "h2",
        text: "What a solo senior actually delivers",
      },
      {
        type: "ul",
        items: [
          "One inbox, one engineer, one shared Slack channel",
          "Decisions made in minutes, not in a Tuesday stand up next week",
          "The same person writing the auth flow, the database schema and the Stripe webhook",
          "No knowledge silos because there is no team to silo across",
          "Source code handover the day we launch, no licensing nonsense",
        ],
      },
      {
        type: "h2",
        text: "When the agency is actually correct",
      },
      {
        type: "p",
        text: "Agencies exist for a reason. If your project needs a brand strategy, a market positioning workshop, a design system, motion direction, copywriting, a six month rollout plan and a media buy, you need an agency. That is not what most founders need. Most founders need software to ship by a date that already exists in a board deck.",
      },
      {
        type: "p",
        text: "If the actual deliverable is a working web platform, hire one senior freelance Next.js developer in the UK. If the deliverable is a 70 slide pitch deck, hire an agency.",
      },
      {
        type: "h2",
        text: "How to vet a solo senior",
      },
      {
        type: "ul",
        items: [
          "Ask for production URLs you can poke at right now (not Dribbble screenshots)",
          "Ask how long the engagement is and whether the price is fixed",
          "Ask who owns the code on day one and on day ninety",
          "Ask what the stack is and why",
          "Ask for one client you can ring",
        ],
      },
      {
        type: "p",
        text: "If they answer those five questions in under two minutes with specifics, you have found a senior. If they need a slide deck to answer, walk.",
      },
      {
        type: "h2",
        text: "What I tell founders honestly",
      },
      {
        type: "p",
        text: "I have lost work to agencies and I have won work back from agencies after the agency stalled. The pattern is always the same. The founder picks the safe option, the safe option takes nine months, the founder lands back in my inbox with a launch date that has already moved twice. By the time they hire me they are paying for the project twice. Save yourself the round trip.",
      },
    ],
  },
  {
    slug: "production-stack-2026",
    title: "My production stack in 2026: Next.js, TypeScript, Postgres, Stripe, Clerk",
    excerpt:
      "The stack I ship every UK SaaS build on, why each piece earned its place, and the ones I keep getting asked about but refuse to use.",
    date: "Feb 2026",
    dateISO: "2026-02-04",
    author: "Salekh Ventures",
    readingMinutes: 7,
    keywords: [
      "Next.js TypeScript Postgres Stripe Clerk",
      "SaaS stack 2026",
      "best stack for MVP UK",
      "Next.js developer UK",
      "Stripe integration developer",
      "Clerk auth developer",
    ],
    body: [
      {
        type: "p",
        text: "Founders ask me on every scope call what the stack is and why. So here is the opinionated answer in one place. This is the stack I use on every UK SaaS build I take on, from regulated pharmacy platforms to compliance dashboards to digital banking flows.",
      },
      {
        type: "h2",
        text: "Next.js (App Router, TypeScript)",
      },
      {
        type: "p",
        text: "Server components, route handlers, server actions, edge runtime where it makes sense. The App Router is no longer the new thing, it is the default thing, and in 2026 there is no faster path from idea to production SaaS than Next.js with TypeScript.",
      },
      {
        type: "p",
        text: "If anyone is still pitching you a Create React App spa with a separate Express backend, run.",
      },
      {
        type: "h2",
        text: "Postgres (via Neon or Supabase)",
      },
      {
        type: "p",
        text: "Boring, battle tested, will outlive every framework debate. I reach for Neon when I want serverless branching for previews, Supabase when I want auth and storage in the same dashboard. Either way you end up writing real SQL eventually, and Postgres rewards that.",
      },
      {
        type: "p",
        text: "MongoDB is fine if you genuinely have unstructured data. Most founders do not. They have relational data and they keep telling themselves it is not relational because that document store demo looked easy.",
      },
      {
        type: "h2",
        text: "Stripe",
      },
      {
        type: "p",
        text: "Subscriptions, metered billing, Connect for marketplaces, customer portal, tax. Stripe is one of the few APIs that gets better every year. I have not had a single project where another payment provider was the right answer for a UK founder.",
      },
      {
        type: "h2",
        text: "Clerk",
      },
      {
        type: "p",
        text: "Auth is the most over engineered thing in software. Clerk solves it in an afternoon. Social login, magic links, MFA, organisations, billing tie ins. You can self host the auth flow if you want, but most UK SaaS founders are paying themselves to write auth instead of building the actual product. Clerk gets that hour back every day.",
      },
      {
        type: "h2",
        text: "Vercel",
      },
      {
        type: "p",
        text: "Edge, ISR, previews per branch, image optimisation, analytics. The price doubles past the hobby tier but the time saved is worth a multiple of that. If you are a UK founder funding the bill personally, I will move you onto a self managed Docker setup the moment the maths flips. Until then, Vercel.",
      },
      {
        type: "h2",
        text: "Resend for email",
      },
      {
        type: "p",
        text: "Postmark and SendGrid both still work. I use Resend because the developer experience is a foregone conclusion and the deliverability has been clean across every UK domain I have run through it.",
      },
      {
        type: "h2",
        text: "Claude or OpenAI for AI features",
      },
      {
        type: "p",
        text: "If the build needs AI baked in, Claude is my default for reasoning heavy workloads and structured outputs, OpenAI when I need image input or speech. Most founders ask for AI features for marketing reasons. I push back hard until we find one where the AI is actually load bearing in the product.",
      },
      {
        type: "h2",
        text: "What I refuse to use",
      },
      {
        type: "ul",
        items: [
          "Bubble or Webflow for anything that needs to scale past a landing page",
          "MongoDB for relational data masquerading as documents",
          "Tailwind UI starter templates pretending to be design",
          "Firebase past the prototype phase (vendor lock plus expensive at scale)",
          "Any auth provider that prices per seat at the MVP stage",
        ],
      },
      {
        type: "h2",
        text: "Why this stack wins UK founders work",
      },
      {
        type: "p",
        text: "Every piece in here is hireable. If we part ways in eighteen months, you can hire the next Next.js developer in the UK off LinkedIn and they will understand the codebase the same day. That portability matters more than which framework had the cooler launch video.",
      },
    ],
  },
  {
    slug: "six-week-fixed-price-build",
    title: "Six weeks, fixed price, fixed scope. What the Build engagement actually looks like",
    excerpt:
      "The exact week by week shape of a £10k fixed price build for a UK founder. Scope call to handover, with the bits I never used to publish.",
    date: "Jan 2026",
    dateISO: "2026-01-18",
    author: "Salekh Ventures",
    readingMinutes: 6,
    keywords: [
      "fixed price web development UK",
      "MVP developer UK",
      "Next.js build process",
      "freelance Next.js developer UK",
      "SaaS MVP six weeks",
    ],
    body: [
      {
        type: "p",
        text: "The Build engagement is the standard package on my pricing page. Six weeks, fixed price, fixed scope, one engineer. Here is the actual shape of those six weeks so you know what you are buying before you sign anything.",
      },
      {
        type: "h2",
        text: "Week zero: scope and spec",
      },
      {
        type: "p",
        text: "Before week one starts we run a scope call. Sixty minutes, no slides. By the end of it I will know the shape of the product, the user journeys, the integrations, and the must haves. I write the spec inside 48 hours and you sign one page that locks the scope.",
      },
      {
        type: "p",
        text: "Locked scope is the part founders find scary and the part that protects you. It means change requests are quoted separately so the original budget always holds. The number on the invoice on day one is the number on the invoice on day forty two.",
      },
      {
        type: "h2",
        text: "Week one: foundation",
      },
      {
        type: "ul",
        items: [
          "Repo, CI, Vercel project, custom domain wired in",
          "Postgres provisioned, schema sketched, migrations running",
          "Clerk auth flow live, sign in working end to end",
          "Design tokens, base layout, the first three pages styled",
          "First Loom update on Friday with a working preview URL",
        ],
      },
      {
        type: "h2",
        text: "Week two and three: core product",
      },
      {
        type: "p",
        text: "This is where the actual product gets built. Dashboards, the main CRUD, the workflows that earn the product its existence. By end of week three you have something you can demo to a real user and get real feedback.",
      },
      {
        type: "h2",
        text: "Week four: integrations and payments",
      },
      {
        type: "p",
        text: "Stripe wired up with subscriptions or one off payments, depending on the model. Email transactional flows hooked into Resend. Any third party integrations the product depends on, like Google Calendar, Twilio or a regulator API for compliance work.",
      },
      {
        type: "h2",
        text: "Week five: edges, polish, hardening",
      },
      {
        type: "ul",
        items: [
          "Error states, empty states, loading skeletons",
          "Mobile breakpoints walked through on real devices",
          "Rate limiting, input validation, auth checks audited",
          "Performance pass with Lighthouse and real network throttling",
          "Accessibility pass, focus states, keyboard nav",
        ],
      },
      {
        type: "h2",
        text: "Week six: launch and handover",
      },
      {
        type: "p",
        text: "Production cutover, DNS, SSL, monitoring, analytics, status page if the product needs one. Full source handed over via your GitHub org, environment variables documented, runbook written, and a 60 minute walkthrough call where I screenshare the entire codebase so your next engineer can land it.",
      },
      {
        type: "h2",
        text: "What you get on day 43",
      },
      {
        type: "ul",
        items: [
          "A production Next.js application live on your domain",
          "A repo you own outright with full commit history",
          "A README that another senior engineer can pick up in an hour",
          "Two weeks of post launch bug support included, no extra cost",
        ],
      },
      {
        type: "h2",
        text: "Why this shape works for UK founders",
      },
      {
        type: "p",
        text: "Most UK SaaS founders I work with are raising, have a board, or have a launch event with a date on it. Fixed scope plus fixed price plus a fixed end date is the only model that protects all three of those constraints at once. Hourly billing protects none of them.",
      },
    ],
  },
  {
    slug: "vision-bank-case-study",
    title: "Building Vision Bank: digital banking from zero in fourteen weeks",
    excerpt:
      "A short case study on shipping a digital bank front end and ops platform end to end with one senior engineer and a regulated brief.",
    date: "Dec 2025",
    dateISO: "2025-12-09",
    author: "Salekh Ventures",
    readingMinutes: 5,
    keywords: [
      "digital banking developer UK",
      "Next.js fintech developer",
      "senior freelance engineer London",
      "high ticket developer UK",
      "regulated software UK",
    ],
    body: [
      {
        type: "p",
        text: "Vision Bank is the one I get asked about most. A digital bank, a regulated brief, a tight runway, and a launch date the team had already announced. Here is roughly how it went and what I would do the same way next time.",
      },
      {
        type: "h2",
        text: "The brief",
      },
      {
        type: "p",
        text: "A front of house web platform plus an internal operations console for a digital bank serving customers across the Gulf and the UK. Customer onboarding, KYC, account opening journeys, a marketing site that ranked, and an admin platform the ops team could actually run the bank from on day one.",
      },
      {
        type: "h2",
        text: "What I built it on",
      },
      {
        type: "ul",
        items: [
          "Next.js with the App Router, TypeScript end to end",
          "Postgres for customer data, with strict row level security on the admin side",
          "Clerk for staff auth, custom flow for customer onboarding",
          "Stripe for card issuing handoffs and subscription products",
          "Vercel for the public site, dedicated infra for the regulated bits",
        ],
      },
      {
        type: "h2",
        text: "The hardest part",
      },
      {
        type: "p",
        text: "Not the code. The regulator. Anyone telling you that the engineering is the hard part of regulated software in the UK has never sat through a six hour meeting on data residency. The lesson I keep relearning is that you build the audit trail before you build the feature, every time.",
      },
      {
        type: "h2",
        text: "What I would do the same again",
      },
      {
        type: "ul",
        items: [
          "Stack chosen first, scope locked second, sequencing third",
          "Three week sprint to a working internal demo, then iterate",
          "Internal ops console treated as a first class product, not a hack",
          "Loom updates every Friday so the founders never wondered where it was",
        ],
      },
      {
        type: "h2",
        text: "What I would do differently",
      },
      {
        type: "p",
        text: "I would spend an extra week on the KYC flows up front. Every fintech project underestimates KYC. Pay that tax in week one and the rest of the build is easier.",
      },
      {
        type: "p",
        text: "If you are a UK founder building anything in the regulated space, drop me a line. High ticket dev work in the UK earns its rate when the brief is this kind of brief.",
      },
    ],
  },
  {
    slug: "claude-in-your-saas",
    title: "Why every UK SaaS founder should bake Claude into the product (properly)",
    excerpt:
      "AI features sell rounds. AI features that earn their place in the product earn revenue. Here is how I integrate Claude into UK SaaS builds without it being a gimmick.",
    date: "Nov 2025",
    dateISO: "2025-11-03",
    author: "Salekh Ventures",
    readingMinutes: 6,
    keywords: [
      "Claude integration UK",
      "AI developer UK",
      "AI integration developer UK",
      "Next.js Claude developer",
      "high ticket developer UK",
      "SaaS AI features",
    ],
    body: [
      {
        type: "p",
        text: "Half the founders who scope a build with me ask for AI in the product. Most of them have a vague idea that AI will make the round easier. Some of them have a real workflow that AI would massively speed up. The job of the engineer is to tell the difference and only build the second one.",
      },
      {
        type: "h2",
        text: "When AI in your SaaS is a gimmick",
      },
      {
        type: "ul",
        items: [
          "A floating chat bubble that nobody clicks",
          "A page that summarises a thing the user already understands",
          "An autocomplete that interrupts the user mid thought",
          "A blog post generator nobody asked for",
        ],
      },
      {
        type: "h2",
        text: "When AI in your SaaS earns its keep",
      },
      {
        type: "ul",
        items: [
          "Pulling structured data out of messy uploads (PDFs, emails, photos)",
          "Drafting the first version of a thing a human refines (proposals, reports)",
          "Triaging tickets, leads or alerts by priority",
          "Turning a 90 minute analyst job into a 4 minute review",
          "Answering questions over a body of internal docs that change weekly",
        ],
      },
      {
        type: "h2",
        text: "How I integrate Claude in a UK SaaS build",
      },
      {
        type: "p",
        text: "Claude is my default for reasoning heavy workloads and structured outputs. I lean on the tool use API for anything that has to interact with your database or third party APIs, and I lean on prompt caching for anything where the same system prompt is used a thousand times a day. Streaming responses go straight into the UI via server actions, no separate websocket plumbing required.",
      },
      {
        type: "p",
        text: "On the regulated builds, all Claude calls go through a single internal SDK so we can audit every prompt, every response and every tool call. That is the part most agencies skip and the part the compliance team asks for in month three.",
      },
      {
        type: "h2",
        text: "What an AI feature costs to build",
      },
      {
        type: "p",
        text: "Roughly one to three weeks of build time depending on whether it is a single prompt feature or a retrieval augmented pipeline with embeddings. Inside a fixed price Build I scope it as one of the deliverables, not as an add on, so the founder is not paying twice.",
      },
      {
        type: "h2",
        text: "Bottom line for UK founders",
      },
      {
        type: "p",
        text: "If you are a UK SaaS founder thinking about AI integration, ask one question. Can the user do the same thing without AI today, only slower or worse. If yes, build it. If no, do not let an engineer talk you into adding it just because the demo looked cool.",
      },
    ],
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
