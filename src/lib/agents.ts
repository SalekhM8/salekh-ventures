/* The catalogue of agent jobs. One list, used by the home page, the team form
   and the house. Agreed with Salekh on 15 Nov 2026. Only two of these are
   built so far (Data: Daily Read, Research: Market Report); the page presents
   them as jobs an agent is built and trained for, not as things already
   running. */

export type CatalogueAgent = { name: string; job: string };
export type CatalogueDepartment = { id: string; name: string; line: string; agents: CatalogueAgent[] };

export const CATALOGUE: CatalogueDepartment[] = [
  {
    id: "customer-relations",
    name: "Customer Relations",
    line: "Every customer answered, in your voice.",
    agents: [
      { name: "Inbox Reply", job: "Answers customer emails from your own knowledge base" },
      { name: "WhatsApp Reply", job: "Answers WhatsApp messages in your voice" },
      { name: "Social DM Reply", job: "Answers Instagram, Facebook and TikTok messages" },
      { name: "Review Responder", job: "Replies to Google and Trustpilot reviews" },
      { name: "Order and Booking Status", job: "Answers “where is my order” from the customer’s own record" },
      { name: "Complaints Triage", job: "Spots complaints and hands them to a person with a summary" },
      { name: "Knowledge Keeper", job: "Keeps your FAQ current from the questions that keep coming up" },
      { name: "Win-back", job: "Follows up lapsed customers and abandoned enquiries" },
    ],
  },
  {
    id: "outreach",
    name: "Outreach",
    line: "New customers found and contacted. You take the calls.",
    agents: [
      { name: "Lead Finder", job: "Builds lists of businesses that fit your target" },
      { name: "Lead Researcher", job: "Writes a short brief on each lead before contact" },
      { name: "Cold Email Writer", job: "Writes first emails tailored to each lead" },
      { name: "DM Opener", job: "Writes first messages for social platforms" },
      { name: "Follow-up Sequencer", job: "Sends the second and third touch on schedule" },
      { name: "Reply Sorter", job: "Reads replies and sorts interested, not now and no" },
      { name: "Call Prep", job: "Hands you a one page brief before each call" },
      { name: "Pipeline Keeper", job: "Keeps the lead tracker accurate and flags stale deals" },
    ],
  },
  {
    id: "content",
    name: "Content",
    line: "Scripts, captions and edited video. You just film.",
    agents: [
      { name: "Script Writer", job: "Writes short video scripts" },
      { name: "Caption Writer", job: "Writes captions and hashtags for each platform" },
      { name: "Hook Tester", job: "Writes opening lines and ranks them against past results" },
      { name: "Video Editor", job: "Cuts, captions and subtitles your raw footage" },
      { name: "Static Designer", job: "Makes carousels and image posts" },
      { name: "Content Planner", job: "Plans the week’s posts against your goals" },
      { name: "Repurposer", job: "Turns one video or article into posts for every platform" },
      { name: "Filming Brief", job: "Tells you exactly what to film: script, shots, where it goes" },
      { name: "Article Writer", job: "Writes blog posts aimed at search" },
    ],
  },
  {
    id: "ads",
    name: "Ads",
    line: "Campaigns run against your targets, inside your limits.",
    agents: [
      { name: "Campaign Planner", job: "Proposes campaigns and structure against your targets" },
      { name: "Ad Copywriter", job: "Writes ad text and headlines" },
      { name: "Creative Brief", job: "Tells Content which ad assets are needed and why" },
      { name: "Budget Manager", job: "Moves spend between ad sets inside your caps" },
      { name: "Performance Watcher", job: "Checks results daily and pauses what is losing" },
      { name: "Audience Builder", job: "Proposes targeting and audiences" },
      { name: "Landing Page Checker", job: "Checks the page each ad points to matches the ad" },
      { name: "Ad Compliance", job: "Checks every ad against platform and industry rules first" },
    ],
  },
  {
    id: "data",
    name: "Data",
    line: "The numbers read every day, and what they mean.",
    agents: [
      { name: "Daily Read", job: "Yesterday’s numbers against target" },
      { name: "Weekly Report", job: "The week on one page, with causes" },
      { name: "Funnel Analyst", job: "Where people drop off between visit and sale" },
      { name: "Attribution", job: "Which channels and ads actually produced customers" },
      { name: "Revenue and Retention", job: "Revenue, repeat rate and churn over time" },
      { name: "Anomaly Alert", job: "Tells you the moment a number moves unusually" },
      { name: "Tracking Auditor", job: "Checks your tracking is still recording properly" },
    ],
  },
  {
    id: "engineering",
    name: "Engineering",
    line: "Your site and app kept working and improving.",
    agents: [
      { name: "Bug Fixer", job: "Fixes reported bugs as changes a person reviews" },
      { name: "Small Features", job: "Ships small improvements" },
      { name: "Tracking Maintainer", job: "Keeps pixels and analytics working" },
      { name: "Speed and Search", job: "Fixes site speed and technical search issues" },
      { name: "Test Writer", job: "Adds tests to code that has none" },
      { name: "Updates and Security", job: "Keeps libraries current and patches known holes" },
      { name: "Integration Maintainer", job: "Keeps payment, email and other connections healthy" },
    ],
  },
  {
    id: "research",
    name: "Research",
    line: "Your market and competitors, written up with sources.",
    agents: [
      { name: "Market Report", job: "A sourced report on any market question" },
      { name: "Competitor Watch", job: "Tracks what competitors launch, say and charge" },
      { name: "Pricing Research", job: "Compares prices across your market" },
      { name: "Customer Voice", job: "Mines reviews and messages for what customers want" },
      { name: "Trend Spotter", job: "Flags trends in your niche worth acting on" },
    ],
  },
  {
    id: "house",
    name: "Running the house",
    line: "One place that directs the rest and reports to you.",
    agents: [
      { name: "Chief of Staff", job: "Decides who works on what and answers your questions" },
      { name: "Daily Digest", job: "One summary of everything, each morning" },
      { name: "Admin Assistant", job: "Chases invoices, reminders and routine admin" },
    ],
  },
];

export const AGENT_COUNT = CATALOGUE.reduce((n, d) => n + d.agents.length, 0);

/** Which department an agent belongs to, by agent name. */
export const DEPARTMENT_OF: Record<string, string> = Object.fromEntries(
  CATALOGUE.flatMap((d) => d.agents.map((a) => [a.name, d.name] as const)),
);
