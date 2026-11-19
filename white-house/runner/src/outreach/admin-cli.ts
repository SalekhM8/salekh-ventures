import { createDb } from "../control/db.js";
import { changeOutreachSettings, readOutreachSettings, suppress, type SettingsChange } from "./admin.js";

/**
 * npm run suppress -- <website or company number> "<reason>"
 *
 * npm run outreach-settings                                   print the settings in force
 * npm run outreach-settings -- --areas-per-run 8 --batch-size 50
 * npm run outreach-settings -- --exclude-group "Name" --include-group "Other name"
 * npm run outreach-settings -- --daily-at 08:00               or --daily-at off
 * npm run outreach-settings -- --enable-type solicitors       switch a kind of business on (or --disable-type id; "all" for every kind)
 * npm run outreach-settings -- --exclude-group "Name" --type solicitors      groups are per kind; without --type, clinics
 * npm run outreach-settings -- --enquiries-per-day 30         the day's allowance of test enquiries
 * npm run outreach-settings -- --allow-enquiries yes          rung 1 to rung 2: each enquiry then needs approval
 * npm run outreach-settings -- --enquiry-rung 3               the owner's switch: 2 each needs a yes, 3 sent without asking. Never past the action's ceiling
 * npm run outreach-settings -- --room mastore:outreach ...    default salekh-ventures:outreach
 *
 * Connects with the UI's role only: DATABASE_URL_UI and WH_TENANT_ID, from the
 * environment or from runner/.env.
 */
try {
  if (!process.env.DATABASE_URL_UI) process.loadEnvFile(".env");
} catch {
  // No .env file: the environment has to provide them.
}
const url = process.env.DATABASE_URL_UI;
const tenantId = process.env.WH_TENANT_ID;
const [command, ...args] = process.argv.slice(2);
if (!url || !tenantId) {
  console.error("DATABASE_URL_UI and WH_TENANT_ID are needed.");
  process.exit(1);
}
const db = createDb(url, 2);
try {
  if (command === "suppress") {
    const [value, reason] = args;
    if (!value || !reason) throw new Error('Usage: npm run suppress -- <website or company number> "<reason>"');
    const done = await suppress(db, tenantId, value, reason);
    console.log(done.added ? `Suppressed for good (${done.kind}): ${value}` : `Already suppressed (${done.kind}): ${value}`);
  } else if (command === "settings") {
    const change: SettingsChange = {};
    let room = "salekh-ventures:outreach";
    for (let i = 0; i < args.length; i += 2) {
      const [flag, value] = [args[i], args[i + 1]];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === "--room") room = value;
      else if (flag === "--areas-per-run") change.areasPerRun = Number(value);
      else if (flag === "--batch-size") change.batchSize = Number(value);
      else if (flag === "--exclude-group") (change.excludeGroups ??= []).push(value);
      else if (flag === "--include-group") (change.includeGroups ??= []).push(value);
      else if (flag === "--daily-at") change.dailyAt = value;
      else if (flag === "--enquiries-per-day") change.enquiriesPerDay = Number(value);
      else if (flag === "--enable-type") (change.enableTypes ??= []).push(value);
      else if (flag === "--disable-type") (change.disableTypes ??= []).push(value);
      else if (flag === "--type") change.typeId = value;
      else if (flag === "--allow-enquiries") change.allowEnquiries = value === "yes";
      else if (flag === "--enquiry-rung") change.enquiryRung = Number(value);
      else if (flag === "--adopt-new-defaults") change.adoptNewDefaults = value === "yes";
      else throw new Error(`unknown option ${flag}`);
    }
    const now = Object.keys(change).length ? await changeOutreachSettings(db, tenantId, room, change) : await readOutreachSettings(db, tenantId, room);
    const s = now.settings;
    console.log(`${room}`);
    console.log(`  territory:        ${s.area}`);
    console.log("  kinds of business (a run takes the next few kind and place pairs, least recently searched first):");
    for (const t of s.business_types) {
      console.log(`    ${t.enabled ? "ON " : "off"}  ${t.id.padEnd(20)} ${t.name}`);
      console.log(`         searched as: ${t.search_phrases.join(" | ")}. Test by email: ${t.email_test ? "yes" : "no"}. Groups left out: ${t.excluded_groups.length}.`);
      const l = t.leak_assumptions;
      console.log(`         leak assumptions (PLACEHOLDERS until edited): ${l.enquiries_a_month.low} to ${l.enquiries_a_month.high} enquiries a month, ${l.share_lost_to_a_slow_reply.low} to ${l.share_lost_to_a_slow_reply.high} lost, ${l.share_that_would_have_bought.low} to ${l.share_that_would_have_bought.high} would have bought`);
      if (t.card_note) console.log(`         note on every card: ${t.card_note}`);
    }
    console.log("    (Online shops are not a kind here on purpose: a shop has no enquiry-to-booking path to test.)");
    console.log(`  batch size:       ${s.find_per_run} businesses looked at a run`);
    console.log(`  areas per run:    ${s.areas_per_run} of ${s.areas.length} places`);
    console.log(`  front desk roles: ${s.front_desk_roles.join(", ")}`);
    console.log(`  advert max age:   ${s.advert_max_age_days} days`);
    console.log(`  fetch limit:      ${s.max_fetches_per_run} searches and page reads a run`);
    for (const t of s.business_types.filter((x) => x.excluded_groups.length > 0)) console.log(`  excluded groups (${t.id}): ${t.excluded_groups.join(", ")}`);
    console.log(`  runs daily at:    ${now.dailyAt ?? "not scheduled"}`);
    console.log(`  test enquiries:   ${s.test_enquiries ? "on" : "off"}, signed "${s.enquiry_signoff}", ${now.enquiriesPerDay ?? "no allowance set (none can be sent)"} a day, ${s.enquiry_send_gap_seconds} seconds apart`);
    console.log(`  enquiry rung:     ${now.enquiryRung}: ${now.enquiryRung === 1 ? "stored only: nothing is sent" : now.enquiryRung === 2 ? "EACH NEEDS YOUR YES" : "SENT WITHOUT ASKING, inside the limits below"}`);
    console.log(`  limits:           ${now.enquiriesPerDay ?? "no allowance set (none can be sent)"} a day shared evenly across the kinds, ${s.enquiry_send_gap_seconds} seconds apart, one per business ever`);
    console.log(`  sending:          every day ${s.enquiry_send_from} to ${s.enquiry_send_until}, spread across ${s.enquiry_slots.join(", ")} (working day ${s.working_hours_from} to ${s.working_hours_until} on days ${s.working_days.join(",")}; 1 is Monday)`);
    console.log(`  non-working dates: ${s.non_working_dates.length ? s.non_working_dates.join(", ") : "none set. Bank holidays are NOT known to the system: add them to non_working_dates"}`);
    console.log(`  no-send dates:    ${s.enquiry_no_send_dates.length ? s.enquiry_no_send_dates.join(", ") : "none set. Bank holidays are NOT known to the system: add them to enquiry_no_send_dates"}`);
    console.log(`  sending stops for the day after: more than ${s.enquiry_max_failures_a_day} failed sends or bounces, 3 or more complaints in a day (or more than 1 in 10 sent, once 20 have gone), or the mailbox refusing the login. One complaint only blocks that business`);
    console.log(`  shortlist:        everyone tested, worst first. No cut-off`);
  } else {
    throw new Error("Use: suppress, or settings");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
