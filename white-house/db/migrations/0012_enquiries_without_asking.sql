-- 0012: test enquiries that send themselves (rung 3).
--
--   enquiries.status 'queued'   drafted, passed every check, and waiting its turn to be sent WITHOUT an approval.
--                               It is never called "approved": nobody approved it. Like every status but
--                               rejected and expired, it holds the business's one enquiry ever.
--   enquiries.service           the one named service the enquiry asks about, so the check that it names it can
--                               be made again in the moment before sending.

alter table enquiries drop constraint enquiries_status_check;
alter table enquiries add constraint enquiries_status_check
  check (status in ('proposed', 'queued', 'approved', 'sending', 'sent', 'failed', 'rejected', 'expired'));
alter table enquiries add column service text check (service is null or length(service) between 1 and 200);
