-- 0013: enquiries are spread across the times real customers write, not kept to office hours.
--
--   enquiries.sent_slot       the part of the week this enquiry is for: in hours, a weekday evening, or the
--                             weekend. Set by code when it is queued, so each kind of business is tested evenly
--                             across the three. An enquiry waits for its slot.
--   enquiries.opening_state   whether the business was open at the moment it was sent, by the opening hours
--                             Google shows for it: open, closed, or unknown when there are none.

alter table enquiries add column sent_slot text check (sent_slot in ('in_hours', 'evening', 'weekend'));
alter table enquiries add column opening_state text check (opening_state in ('open', 'closed', 'unknown'));
grant update (sent_slot, opening_state) on enquiries to wh_gateway;
