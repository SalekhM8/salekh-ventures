# Mastore: what is tracked and what ad material exists

Drafted from the code on 13 Nov 2026. Not yet corrected by Salekh.

## Tracking

- Meta pixel and TikTok pixel only, in the browser, and only after cookie consent. No PostHog, no server-side conversions.
- Events: page view; `signup`; `activated` (second healthy marketplace connected); `plan_chosen`.
- Every ad and bio link carries a `?src=` tag, stored against the workspace as its sign-up source. Ads use `meta-<angle>` and `tt-ad-<angle>`. Bios use `tt-mastore`, `ig-mastore`, `fb-mastore`.
- Measurable from Mastore's own database: trials by source, activation within 72 hours (two or more marketplaces and one product syncing), trial to paid, paying customers by plan, survey answers, orders synced. A script already computes most of this.
- Not measured: site visits (taken from the ad dashboards), funnel steps between landing and sign-up, churn (derivable from billing status).

## Ad material

- Four angles: Oversell, Time, AI, Price. A vertical video and a static for each, plus two organic posts and a five-slide fee comparison.
- Common line: "14 days free · No contract · Built in the UK". Button: "Sign up".
- The fee comparison slides make claims about other platforms' fees that the code says must be checked against real statements before posting. Treat as unverified.
- The plan on file: about £15 a day each on Meta and TikTok in week one, kill and scale rules, and a ceiling of £19 per trial. To confirm these are still Salekh's numbers.
- No dedicated landing pages for ads: they point to the home page with a `?src=` tag.
