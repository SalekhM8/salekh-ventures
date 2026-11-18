-- 0015: a room's "Results so far today", one output a day that is brought up to date as results come in.
--
-- The agent tools' role adds an output and cannot read it back. The gateway's role, which can read outputs, may
-- now bring the text of one up to date. It still cannot add one, move one to another room, or delete one.

grant update (body, data) on outputs to wh_gateway;
