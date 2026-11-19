-- 0020: how long call notes and follow-up emails are kept.
--
-- Once a day the runner looks for businesses with no new call and no new follow-up for a set time (12 months unless
-- the owner sets WH_NOTES_KEEP_MONTHS). For each, it blanks what was written in words: the note on every call
-- (it may name the person spoken to), and the subject, body and recipient's name of every follow-up that is
-- finished (sent, failed or not sent). What is kept: the outcome of each call and when, and that an email was sent,
-- when, and to which address (a sent email must keep its address, 0017).
--
-- Call outcomes stay append only in everything but this: the gateway's role may now set a note to null, and a
-- trigger refuses any other change, so the history of what happened on each call cannot be rewritten.

grant update (note) on call_outcomes to wh_gateway;

create function wh_call_outcomes_only_clear_note() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.note is not null or (to_jsonb(new) - 'note') is distinct from (to_jsonb(old) - 'note') then
    raise exception 'call outcomes are kept as they were: only a note can be cleared';
  end if;
  return new;
end
$$;

create trigger call_outcomes_only_clear_note before update on call_outcomes
  for each row execute function wh_call_outcomes_only_clear_note();

-- When a follow-up's words were cleared. Null: not cleared.
alter table followups add column cleared_at timestamptz;
grant update (cleared_at) on followups to wh_gateway;
