# Twilight

Status: drafted from the Twilight code on 13 Nov 2026. Not yet corrected by Salekh. This replaces the earlier one-line description ("a TikTok account Salekh runs"), which the code shows was incomplete. Longer notes are in `knowledge/`.

## What it is

- Twilight Pharmacy: a community pharmacy in Birmingham (Twilight UK Limited). One business, two websites.
- Main pharmacy site: booking for in-branch services, travel and NHS services.
- Online clinic: prescription weight-loss treatment reviewed by a pharmacist independent prescriber, plus a supplements shop. Live since 7 Oct 2026.
- Salekh builds and runs the technology, ads, tracking and email for it. His formal role and who signs off content are to confirm.

## Hard limits (same footing as ROOTS: BRIEF.md sections 6 and 11)

- Anything clinical, dispensing related or about a patient's health goes to the pharmacist. An agent only recognises and routes. When unsure, it routes.
- No agent decides whether someone gets treatment, and no agent approves, rejects or changes a prescription, a payment or an audit record.
- Prescription only medicines cannot be advertised to the public. Ads and ad landing pages never name a medicine. No efficacy claims, no before and after, no "buy now", no price anchoring.
- Any ad or creative for the clinic needs Salekh's approval every time.
- No patient level data. Counts and totals only. Never open or quote consultation answers, photos, prescriptions, or the scripts and files that name individual customers.
- Only neutral events go to Meta. The main site stays out of the clinic's Meta dataset.
- Never reuse anything belonging to ROOTS (pixels, ad accounts, review widgets, domain).

## Do not state without checking the live site or asking Salekh

Any price. The number of branches (the code says three in one place and two in another). "Since 2006". Review counts. Who dispenses. CQC status.

## How it talks

Plain, short sentences. No dashes. Clinic: "Three minutes online. A pharmacist reads it. You decide." Main site: "Tune out the noise. Tune into your health."

## To be supplied by Salekh

Whether Twilight is his or a client's, and who approves ads and clinical copy. Targets and ad budgets. Which departments he wants.
