-- 0010: Google Places as the main way to find businesses.
--
--   prospects.place_id   Google's id for the place: one more key that stops a
--                        business being recorded twice.
--   prospects.places     what Places said about the business when it was found:
--                        rating, number of reviews, phone, opening hours, where
--                        it is. Facts about a business, never about a reviewer:
--                        no review text and no reviewer's name is stored.

alter table prospects add column place_id text;
alter table prospects add column places jsonb;
create unique index prospects_place_idx on prospects (tenant_id, business_id, place_id) where place_id is not null;
grant update (place_id, places) on prospects to wh_gateway;
