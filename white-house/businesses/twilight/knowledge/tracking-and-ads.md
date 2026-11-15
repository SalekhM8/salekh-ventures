# Twilight: what is tracked and what ad material exists

Drafted from the code on 13 Nov 2026. Not yet corrected by Salekh.

## Tracking

- PostHog on both sites, one shared project, so a visitor moving from the main site to the clinic is one person. Paths only. On the clinic, consultation, account, admin and sign-in pages are stripped completely by design.
- Clinic events: page views, `checkout_form_started`, `checkout_pay_pressed`, `checkout_error`.
- Meta: neutral events only (page view, view content, checkout started, order confirmed, consultation submitted), with hashed contact details and no product or health data. Purchase style events were removed after Meta restricted the earlier dataset. A new dataset was connected on 12 Nov 2026.
- Google Ads: purchase and checkout started conversions.
- Links from the main site to the clinic carry UTM tags by placement. Short links exist for social bios, Google listings, a bag sticker and emails.
- Attribution (source, campaign) is stored against each consultation in the clinic's database. Reading it needs database access and must stay at the level of counts.

## Ad material

- Static Meta ads in several sizes and an iMessage style ad. Angles: "Online clinics. Then there's us.", "£0 to find out if you qualify", a real pharmacy now online, and switching provider with no restart and no subscription. None names a medicine.
- Three ad landing pages with no medicine names.
- Meta rejected every ad after one copy change in October under its drugs policy, and the copy was reverted to the approved version. Copy changes carry real risk of rejection.
- Claims in the creatives that need checking before reuse: "since 2006", the review count, "two branches", and any comparison with other providers' prices.
- A competitor price table exists (about 1,470 rows across online pharmacies).
- No content plan, scripts, budgets or TikTok material were found.
