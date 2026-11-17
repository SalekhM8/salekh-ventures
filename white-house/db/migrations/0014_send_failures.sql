-- 0014: why a send failed.
--
--   enquiries.failure   a fixed code for why an enquiry is marked failed, with the network error code when there
--                       was one ("send_failed:ETIMEDOUT"). Never the server's words, an address or any text of
--                       the message. NULL on rows that failed before this was recorded.

alter table enquiries add column failure text check (failure is null or failure ~ '^[a-z_]+(:[A-Z0-9_]{1,40})?$');
grant update (failure) on enquiries to wh_gateway;
