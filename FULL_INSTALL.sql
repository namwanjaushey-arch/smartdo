-- =====================================================================
-- SMART DOBI · FULL INSTALL (use this on a NEW, EMPTY Supabase project)
--
-- How to use: Supabase -> SQL Editor -> New query -> paste ALL of this -> Run.
-- It runs as ONE unit: if any line fails, nothing is applied. Send me the exact error.
--
-- WHO BECOMES SUPER ADMIN: the FIRST account created after this script runs.
-- Create your own account immediately afterwards. To be extra safe, put your email
-- between the quotes on the line marked "CHANGE ME" (search for it below) BEFORE you run.
--
-- WARNING: this script starts by deleting any existing Smart Dobi tables.
-- Never run it on a project that already holds real data. Use UPDATE_6_ONLY.sql instead.
-- =====================================================================


-- ############ PART 1: Tables and rules ############
-- =====================================================================
-- Smart Dobi · Supabase schema (clean, single file)
-- Paste ALL of this into Supabase → SQL Editor → New query → Run.
-- It first removes any earlier Smart Dobi tables (safe on a new project).
-- WARNING: running it again later deletes Smart Dobi data. Future changes
-- will come as small separate update scripts.
-- =====================================================================

-- 0. Clean slate -------------------------------------------------------
drop table if exists requests, expenses, pin_failures, workers, audit_events, payments,
  garment_history, garments, orders, customers, memberships, branches, businesses, plans cascade;
drop function if exists my_role(uuid), can_branch(uuid,uuid), enforce_branch_limit(), enforce_worker_limit(),
  create_business(text,text), create_business(text,text,text,text,text,text,text), track_order(text),
  verify_branch_pin(uuid,text), verify_admin_pin(uuid,text), set_branch_pin(uuid,text), set_admin_pin(uuid,text),
  log_event(uuid,uuid,text,text,jsonb), submit_request(uuid,text,text,text,text,text),
  search_dobis(text,text,text[],boolean) cascade;
drop type if exists garment_status, app_role cascade;

-- 1. Extension and types -------------------------------------------------
create extension if not exists pgcrypto with schema extensions;
create type app_role as enum ('owner','manager','worker','cashier');
create type garment_status as enum ('received','queued','washing','drying','ironing','qc','ready','rework','returned','cancelled');

-- 2. Tables --------------------------------------------------------------
create table plans(
  id text primary key, name text not null, price_ugx int not null,
  max_branches int not null, max_workers_per_branch int not null, retention_hours int not null,
  entitlements jsonb not null default '{}'::jsonb);
insert into plans(id,name,price_ugx,max_branches,max_workers_per_branch,retention_hours,entitlements) values
 ('starter','Starter',10000,1,3,48,'{"white_label":false}'),
 ('growth','Growth',30000,3,5,168,'{"white_label":false}'),
 ('pro','Pro',50000,5,8,720,'{"white_label":false}'),
 ('premium','Business Premium',100000,10,15,2160,'{"white_label":true}');

create table businesses(
  id uuid primary key default gen_random_uuid(), name text not null, owner_name text, phone text, email text, logo_path text,
  plan_id text not null default 'starter' references plans(id), currency text not null default 'UGX',
  timezone text not null default 'Africa/Kampala', pay_before_release boolean not null default false,
  admin_pin_hash text, created_at timestamptz not null default now());

create table branches(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  name text not null, address text, phone text, area text, hours text, about text,
  services text[] not null default '{}', pickup_delivery boolean not null default false,
  listed boolean not null default false, pin_hash text, created_at timestamptz not null default now());

create table memberships(
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  role app_role not null, branch_id uuid references branches(id), active boolean not null default true,
  primary key(user_id, business_id));

create table workers(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade, name text not null,
  active boolean not null default true, created_at timestamptz not null default now());

create table customers(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  name text not null, phone text, email text, created_at timestamptz not null default now());

create table orders(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  branch_id uuid not null references branches(id), customer_id uuid not null references customers(id),
  order_no text not null, received_by uuid references auth.users(id), received_by_name text,
  tracking_token_hash text unique, tracking_enabled boolean not null default true,
  closed_at timestamptz, cleared_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(business_id, order_no));

create table garments(
  id uuid primary key default gen_random_uuid(), order_id uuid not null references orders(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade, type text not null,
  qty int not null default 1 check(qty > 0), color text, description text,
  status garment_status not null default 'received', unit_price_ugx numeric(12,0) check(unit_price_ugx >= 0),
  photo_path text, internal_note text, rework_reason text);

create table garment_history(
  id bigserial primary key, garment_id uuid not null references garments(id) on delete cascade,
  status garment_status not null, by_user uuid references auth.users(id), at timestamptz not null default now());

create table payments(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  order_id uuid not null references orders(id), amount_ugx numeric(12,0) not null check(amount_ugx <> 0),
  method text not null, txn_id text, comment text, receipt_no text unique,
  verified boolean not null default false, reversal_of uuid references payments(id),
  recorded_by uuid references auth.users(id), recorded_by_name text, at timestamptz not null default now());

create table expenses(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  branch_id uuid not null references branches(id), spent_on date not null, category text not null,
  amount_ugx numeric(12,0) not null check(amount_ugx > 0), method text, description text, recorded_by text,
  void_by text, void_at timestamptz, created_at timestamptz not null default now());

create table requests(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade, kind text not null check(kind in ('pkg','cb')),
  name text not null, phone text not null, note text, how text, status text not null default 'new',
  order_id uuid references orders(id), created_at timestamptz not null default now());

create table audit_events(
  id bigserial primary key, business_id uuid, branch_id uuid, actor uuid, who text, action text not null,
  detail jsonb not null default '{}'::jsonb, at timestamptz not null default now());

create table pin_failures(
  id bigserial primary key, user_id uuid, scope text, at timestamptz not null default now());

create index on branches(business_id);
create index on workers(branch_id);
create index on orders(business_id, branch_id, created_at desc);
create index on garments(order_id);
create index on payments(order_id);
create index on requests(branch_id, status);
create index on audit_events(business_id, at desc);

-- 3. Helper functions ----------------------------------------------------
create function my_role(b uuid) returns app_role language sql stable security definer set search_path = public as
$$ select role from memberships where user_id = auth.uid() and business_id = b and active $$;

create function can_branch(b uuid, br uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from memberships where user_id = auth.uid() and business_id = b and active
                 and (branch_id is null or branch_id = br)) $$;

-- Plan limits enforced inside the database
create function enforce_branch_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from branches where business_id = new.business_id) >=
     (select p.max_branches from plans p join businesses bz on bz.plan_id = p.id where bz.id = new.business_id)
  then raise exception 'Branch limit reached for your plan. Upgrade to add more branches.'; end if;
  return new;
end $$;
create trigger branch_limit before insert on branches for each row execute function enforce_branch_limit();

create function enforce_worker_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from workers where branch_id = new.branch_id and active) >=
     (select p.max_workers_per_branch from plans p join businesses bz on bz.plan_id = p.id where bz.id = new.business_id)
  then raise exception 'Worker limit reached for your plan. Upgrade to add more workers.'; end if;
  return new;
end $$;
create trigger worker_limit before insert on workers for each row execute function enforce_worker_limit();

-- 4. App functions (called from the website) ---------------------------------
create function create_business(p_name text, p_owner text, p_branch text, p_admin_pin text, p_branch_pin text, p_phone text, p_email text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare nb uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_admin_pin !~ '^[0-9]{4,5}$' or p_branch_pin !~ '^[0-9]{4,5}$' then raise exception 'PINs must be 4 or 5 digits'; end if;
  insert into businesses(name, owner_name, phone, email, admin_pin_hash)
    values (p_name, p_owner, p_phone, p_email, crypt(p_admin_pin, gen_salt('bf'))) returning id into nb;
  insert into branches(business_id, name, pin_hash) values (nb, p_branch, crypt(p_branch_pin, gen_salt('bf')));
  insert into memberships(user_id, business_id, role) values (auth.uid(), nb, 'owner');
  return nb;
end $$;

-- PINs are hashed, checked on the server, and limited to 5 wrong tries per 10 minutes
create function verify_branch_pin(p_branch uuid, p_pin text) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean; biz uuid;
begin
  select br.business_id into biz from branches br
    join memberships m on m.business_id = br.business_id and m.user_id = auth.uid() and m.active
    where br.id = p_branch;
  if biz is null then return false; end if;
  if (select count(*) from pin_failures where user_id = auth.uid() and at > now() - interval '10 minutes') >= 5
  then raise exception 'Too many wrong PINs. Try again in 10 minutes.'; end if;
  select (br.pin_hash = crypt(p_pin, br.pin_hash)) into ok from branches br where br.id = p_branch;
  if not coalesce(ok, false) then
    insert into pin_failures(user_id, scope) values (auth.uid(), 'branch:' || p_branch::text);
    insert into audit_events(business_id, branch_id, actor, action) values (biz, p_branch, auth.uid(), 'wrong_branch_pin');
  end if;
  return coalesce(ok, false);
end $$;

create function verify_admin_pin(p_business uuid, p_pin text) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean;
begin
  if my_role(p_business) is null then return false; end if;
  if (select count(*) from pin_failures where user_id = auth.uid() and at > now() - interval '10 minutes') >= 5
  then raise exception 'Too many wrong PINs. Try again in 10 minutes.'; end if;
  select (bz.admin_pin_hash = crypt(p_pin, bz.admin_pin_hash)) into ok from businesses bz where bz.id = p_business;
  if not coalesce(ok, false) then
    insert into pin_failures(user_id, scope) values (auth.uid(), 'admin:' || p_business::text);
    insert into audit_events(business_id, actor, action) values (p_business, auth.uid(), 'wrong_admin_pin');
  end if;
  return coalesce(ok, false);
end $$;

create function set_branch_pin(p_branch uuid, p_pin text) returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{4,5}$' then raise exception 'PIN must be 4 or 5 digits'; end if;
  update branches set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_branch and my_role(business_id) = 'owner';
end $$;

create function set_admin_pin(p_business uuid, p_pin text) returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{4,5}$' then raise exception 'PIN must be 4 or 5 digits'; end if;
  update businesses set admin_pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_business and my_role(id) = 'owner';
end $$;

-- Audit trail: who did what
create function log_event(p_business uuid, p_branch uuid, p_who text, p_action text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as
$$ insert into audit_events(business_id, branch_id, actor, who, action, detail)
   select p_business, p_branch, auth.uid(), p_who, p_action, p_detail where my_role(p_business) is not null $$;

-- Customer tracking page: safe fields only, token compared by hash
create function track_order(p_token text) returns jsonb language sql stable security definer set search_path = public, extensions as
$$ select jsonb_build_object('order_no', o.order_no, 'received_at', o.created_at, 'business', bz.name,
     'customer', split_part(c.name, ' ', 1),
     'garments', (select coalesce(jsonb_agg(jsonb_build_object('type', g.type, 'qty', g.qty, 'color', g.color,
                   'description', g.description, 'status', g.status)), '[]'::jsonb)
                  from garments g where g.order_id = o.id and g.status <> 'cancelled'))
   from orders o join businesses bz on bz.id = o.business_id join customers c on c.id = o.customer_id
   where o.tracking_enabled and o.tracking_token_hash = encode(digest(p_token, 'sha256'), 'hex') $$;

-- Customer request from the public directory
create function submit_request(p_branch uuid, p_kind text, p_name text, p_phone text, p_note text, p_how text) returns void
language plpgsql security definer set search_path = public as $$
declare biz uuid;
begin
  select br.business_id into biz from branches br where br.id = p_branch and br.listed;
  if biz is null then raise exception 'Shop not found'; end if;
  if p_kind not in ('pkg','cb') then raise exception 'Invalid request'; end if;
  if length(coalesce(p_name,'')) < 2 or length(regexp_replace(coalesce(p_phone,''), '[^0-9]', '', 'g')) < 9 then raise exception 'Invalid details'; end if;
  insert into requests(business_id, branch_id, kind, name, phone, note, how)
    values (biz, p_branch, p_kind, left(p_name,80), left(p_phone,20), left(coalesce(p_note,''),500), left(coalesce(p_how,''),80));
end $$;

-- Public directory search: listed shops only, never prices
create function search_dobis(p_q text default '', p_area text default '', p_services text[] default '{}', p_pickup boolean default false)
returns table(branch_id uuid, shop_name text, area text, address text, services text[], pickup_delivery boolean,
              hours text, about text, phone text, email text)
language sql stable security definer set search_path = public as
$$ select br.id,
     bz.name || case when (select count(*) from branches x where x.business_id = bz.id and x.listed) > 1 then ' · ' || br.name else '' end,
     br.area, br.address, br.services, br.pickup_delivery, br.hours, br.about, bz.phone, bz.email
   from branches br join businesses bz on bz.id = br.business_id
   where br.listed
     and (p_q = '' or (bz.name || ' ' || br.name || ' ' || coalesce(br.area,'') || ' ' || array_to_string(br.services,' ')) ilike '%' || p_q || '%')
     and (p_area = '' or br.area = p_area) and br.services @> p_services and (not p_pickup or br.pickup_delivery) $$;

-- Who may call what
revoke execute on function create_business(text,text,text,text,text,text,text), verify_branch_pin(uuid,text),
  verify_admin_pin(uuid,text), set_branch_pin(uuid,text), set_admin_pin(uuid,text),
  log_event(uuid,uuid,text,text,jsonb) from public, anon;
grant execute on function create_business(text,text,text,text,text,text,text), verify_branch_pin(uuid,text),
  verify_admin_pin(uuid,text), set_branch_pin(uuid,text), set_admin_pin(uuid,text),
  log_event(uuid,uuid,text,text,jsonb) to authenticated;
grant execute on function track_order(text), submit_request(uuid,text,text,text,text,text),
  search_dobis(text,text,text[],boolean) to anon, authenticated;

-- 5. Row Level Security: each business only sees its own data ----------------
alter table plans enable row level security;
alter table businesses enable row level security;
alter table branches enable row level security;
alter table memberships enable row level security;
alter table workers enable row level security;
alter table customers enable row level security;
alter table orders enable row level security;
alter table garments enable row level security;
alter table garment_history enable row level security;
alter table payments enable row level security;
alter table expenses enable row level security;
alter table requests enable row level security;
alter table audit_events enable row level security;
alter table pin_failures enable row level security;

create policy plans_read on plans for select using (true);
create policy biz_read on businesses for select using (my_role(id) is not null);
create policy biz_update on businesses for update using (my_role(id) = 'owner');
create policy br_read on branches for select using (can_branch(business_id, id));
create policy br_insert on branches for insert with check (my_role(business_id) = 'owner');
create policy br_update on branches for update using (my_role(business_id) = 'owner');
create policy mem_read on memberships for select using (user_id = auth.uid() or my_role(business_id) = 'owner');
create policy wk_read on workers for select using (my_role(business_id) is not null);
create policy wk_write on workers for all using (my_role(business_id) = 'owner') with check (my_role(business_id) = 'owner');
create policy cust_all on customers for all using (my_role(business_id) is not null) with check (my_role(business_id) is not null);
create policy ord_read on orders for select using (can_branch(business_id, branch_id));
create policy ord_insert on orders for insert with check (can_branch(business_id, branch_id) and my_role(business_id) <> 'cashier');
create policy ord_update on orders for update using (can_branch(business_id, branch_id) and my_role(business_id) <> 'cashier');
create policy gar_read on garments for select using (exists(select 1 from orders o where o.id = garments.order_id and can_branch(o.business_id, o.branch_id)));
create policy gar_write on garments for all
  using (my_role(business_id) in ('owner','manager','worker') and exists(select 1 from orders o where o.id = garments.order_id and can_branch(o.business_id, o.branch_id)))
  with check (my_role(business_id) in ('owner','manager','worker'));
create policy hist_read on garment_history for select using (exists(select 1 from garments g where g.id = garment_history.garment_id and my_role(g.business_id) is not null));
create policy hist_insert on garment_history for insert with check (by_user = auth.uid());
-- Payments: add-only ledger (no update/delete policies). Corrections are reversal rows.
create policy pay_read on payments for select using (my_role(business_id) in ('owner','manager','cashier'));
create policy pay_insert on payments for insert with check (my_role(business_id) in ('owner','manager','cashier') and recorded_by = auth.uid());
create policy exp_read on expenses for select using (my_role(business_id) = 'owner');
create policy exp_insert on expenses for insert with check (my_role(business_id) = 'owner');
create policy exp_update on expenses for update using (my_role(business_id) = 'owner');
create policy req_read on requests for select using (can_branch(business_id, branch_id));
create policy req_update on requests for update using (can_branch(business_id, branch_id));
create policy audit_read on audit_events for select using (my_role(business_id) in ('owner','manager'));
-- pin_failures has no policies on purpose: only the server functions touch it.


-- ############ PART 2: Orders, statuses, tracking page, photo storage ############
-- =====================================================================
-- Smart Dobi · UPDATE 2 (orders, statuses, tracking page, photo storage).
-- =====================================================================
alter table businesses add column if not exists order_seq int not null default 1000;
alter table orders add column if not exists tracking_token text;

create or replace function create_order(p_branch uuid, p_name text, p_phone text, p_email text, p_who text, p_token text, p_garments jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare biz uuid; cid uuid; ord_id uuid; seq int; ono text; g jsonb; gid uuid; ids jsonb := '[]'::jsonb;
begin
  select br.business_id into biz from branches br where br.id = p_branch;
  if biz is null or not can_branch(biz, p_branch) then raise exception 'Not allowed'; end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Customer name required'; end if;
  if p_garments is null or jsonb_typeof(p_garments) <> 'array' or jsonb_array_length(p_garments) = 0 then raise exception 'Add at least one garment'; end if;
  if length(coalesce(p_token,'')) < 32 then raise exception 'Invalid tracking token'; end if;
  update businesses set order_seq = order_seq + 1 where id = biz returning order_seq into seq;
  ono := 'SD-' || seq::text;
  insert into customers(business_id, name, phone, email)
    values (biz, trim(p_name), nullif(trim(coalesce(p_phone,'')),''), nullif(trim(coalesce(p_email,'')),'')) returning id into cid;
  insert into orders(business_id, branch_id, customer_id, order_no, received_by, received_by_name, tracking_token, tracking_token_hash)
    values (biz, p_branch, cid, ono, auth.uid(), left(coalesce(p_who,''),80), p_token, encode(digest(p_token,'sha256'),'hex')) returning id into ord_id;
  for g in select value from jsonb_array_elements(p_garments) loop
    insert into garments(order_id, business_id, type, qty, color, description)
      values (ord_id, biz, left(coalesce(g->>'type','Item'),80), greatest(1, coalesce((g->>'qty')::int,1)),
              left(coalesce(g->>'color',''),60), left(coalesce(g->>'description',''),300)) returning id into gid;
    insert into garment_history(garment_id, status, by_user) values (gid, 'received', auth.uid());
    ids := ids || jsonb_build_array(gid);
  end loop;
  insert into audit_events(business_id, branch_id, actor, who, action, detail)
    values (biz, p_branch, auth.uid(), left(coalesce(p_who,''),80), 'order_received', jsonb_build_object('order_no', ono, 'items', jsonb_array_length(p_garments)));
  return jsonb_build_object('order_id', ord_id, 'order_no', ono, 'garment_ids', ids);
end $$;

create or replace function set_garment_status(p_garment uuid, p_status text, p_who text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare gr garments%rowtype; od orders%rowtype; st garment_status; left_ct int;
begin
  select * into gr from garments where id = p_garment;
  if not found then raise exception 'Garment not found'; end if;
  select * into od from orders where id = gr.order_id;
  if not can_branch(od.business_id, od.branch_id) then raise exception 'Not allowed'; end if;
  st := p_status::garment_status;
  if gr.status in ('returned','cancelled') then raise exception 'This garment is already %', gr.status; end if;
  update garments set status = st, rework_reason = case when st = 'rework' then left(p_reason,200) else rework_reason end where id = p_garment;
  insert into garment_history(garment_id, status, by_user) values (p_garment, st, auth.uid());
  update orders set updated_at = now() where id = od.id;
  if st = 'returned' then
    select count(*) into left_ct from garments where order_id = od.id and status not in ('returned','cancelled');
    if left_ct = 0 then update orders set closed_at = coalesce(closed_at, now()) where id = od.id; end if;
  end if;
  insert into audit_events(business_id, branch_id, actor, who, action, detail)
    values (od.business_id, od.branch_id, auth.uid(), left(coalesce(p_who,''),80),
            case when st = 'returned' then 'garment_returned' else 'garment_status' end,
            jsonb_build_object('order_no', od.order_no, 'type', gr.type, 'from', gr.status::text, 'to', st::text, 'reason', p_reason));
end $$;

-- Owner clears an order. Returns false on a wrong PIN (no error, so the failed attempt is still recorded).
create or replace function clear_order(p_order uuid, p_pin text, p_reason text, p_who text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare od orders%rowtype;
begin
  select * into od from orders where id = p_order;
  if not found then raise exception 'Order not found'; end if;
  if not can_branch(od.business_id, od.branch_id) then raise exception 'Not allowed'; end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Enter a reason'; end if;
  if not verify_admin_pin(od.business_id, p_pin) then return false; end if;
  update orders set closed_at = coalesce(closed_at, now()), cleared_reason = left(trim(p_reason),300), updated_at = now() where id = p_order;
  insert into audit_events(business_id, branch_id, actor, who, action, detail)
    values (od.business_id, od.branch_id, auth.uid(), left(coalesce(p_who,''),80), 'order_cleared',
            jsonb_build_object('order_no', od.order_no, 'reason', left(trim(p_reason),300)));
  return true;
end $$;

create or replace function create_branch(p_business uuid, p_name text, p_pin text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare nb uuid;
begin
  if my_role(p_business) is distinct from 'owner' then raise exception 'Only the owner can add shops'; end if;
  if p_pin !~ '^[0-9]{4,5}$' then raise exception 'PIN must be 4 or 5 digits'; end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Enter a shop name'; end if;
  insert into branches(business_id, name, pin_hash) values (p_business, trim(p_name), crypt(p_pin, gen_salt('bf'))) returning id into nb;
  insert into audit_events(business_id, branch_id, actor, action, detail)
    values (p_business, nb, auth.uid(), 'branch_created', jsonb_build_object('name', trim(p_name)));
  return nb;
end $$;

create or replace function track_order(p_token text) returns jsonb language sql stable security definer set search_path = public, extensions as
$$ select jsonb_build_object('order_no', o.order_no, 'received_at', o.created_at, 'updated_at', o.updated_at,
     'business', bz.name, 'phone', bz.phone, 'email', bz.email, 'customer', split_part(c.name, ' ', 1),
     'closed', o.closed_at is not null,
     'garments', (select coalesce(jsonb_agg(jsonb_build_object('type', g.type, 'qty', g.qty, 'color', g.color,
                   'description', g.description, 'status', g.status, 'photo', g.photo_path) order by g.id), '[]'::jsonb)
                  from garments g where g.order_id = o.id and g.status <> 'cancelled'))
   from orders o join businesses bz on bz.id = o.business_id join customers c on c.id = o.customer_id
   where o.tracking_enabled and o.tracking_token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and (o.closed_at is null or o.closed_at > now() - interval '24 hours') $$;

revoke execute on function create_order(uuid,text,text,text,text,text,jsonb), set_garment_status(uuid,text,text,text),
  clear_order(uuid,text,text,text), create_branch(uuid,text,text) from public, anon;
grant execute on function create_order(uuid,text,text,text,text,text,jsonb), set_garment_status(uuid,text,text,text),
  clear_order(uuid,text,text,text), create_branch(uuid,text,text) to authenticated;
grant execute on function track_order(text) to anon, authenticated;

-- Photo storage: public bucket with unguessable file names; only your own staff can upload or delete
insert into storage.buckets (id, name, public) values ('garment-photos', 'garment-photos', true)
  on conflict (id) do update set public = true;
drop policy if exists "sd photos select" on storage.objects;
drop policy if exists "sd photos insert" on storage.objects;
drop policy if exists "sd photos update" on storage.objects;
drop policy if exists "sd photos delete" on storage.objects;
create policy "sd photos select" on storage.objects for select to authenticated using (
  bucket_id = 'garment-photos' and exists (select 1 from memberships m where m.user_id = auth.uid() and m.active and m.business_id::text = (storage.foldername(name))[1]));
create policy "sd photos insert" on storage.objects for insert to authenticated with check (
  bucket_id = 'garment-photos' and exists (select 1 from memberships m where m.user_id = auth.uid() and m.active and m.business_id::text = (storage.foldername(name))[1]));
create policy "sd photos update" on storage.objects for update to authenticated using (
  bucket_id = 'garment-photos' and exists (select 1 from memberships m where m.user_id = auth.uid() and m.active and m.business_id::text = (storage.foldername(name))[1]))
  with check (bucket_id = 'garment-photos' and exists (select 1 from memberships m where m.user_id = auth.uid() and m.active and m.business_id::text = (storage.foldername(name))[1]));
create policy "sd photos delete" on storage.objects for delete to authenticated using (
  bucket_id = 'garment-photos' and exists (select 1 from memberships m where m.user_id = auth.uid() and m.active and m.business_id::text = (storage.foldername(name))[1]));


-- ############ PART 3: Money and offline sync ############
-- =====================================================================
-- Smart Dobi · UPDATE 3 (money + offline sync). Run once AFTER update 2. Safe to re-run.
-- One function receives a batch of changes saved on a device and applies them.
-- Every change carries its own ID, so a retried sync never records anything twice.
-- =====================================================================
create or replace function sync_money(p_business uuid, p_who text, p_ops jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  op jsonb; res jsonb := '[]'::jsonb; kind text; pid uuid; ts timestamptz; amt numeric;
  o_row orders%rowtype; p_row payments%rowtype; who_name text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if my_role(p_business) is null or my_role(p_business) = 'worker' then raise exception 'Not allowed'; end if;
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then raise exception 'Invalid data'; end if;
  if jsonb_array_length(p_ops) > 500 then raise exception 'Too many changes in one sync'; end if;

  for op in select value from jsonb_array_elements(p_ops) loop
    begin
      kind := op->>'type';
      pid := (op->>'id')::uuid;
      ts := least(coalesce((op->>'at')::timestamptz, now()), now() + interval '1 day');
      who_name := left(coalesce(nullif(op->>'by',''), nullif(op->>'who',''), p_who, ''), 80);

      if kind = 'price' then
        amt := (op->>'price')::numeric;
        if amt < 0 or amt > 100000000 then raise exception 'Invalid price'; end if;
        update garments set unit_price_ugx = round(amt)
          where id = (op->>'garment_id')::uuid and business_id = p_business;
        if not found then raise exception 'Garment not found'; end if;
        insert into audit_events(business_id, actor, who, action, detail)
          values (p_business, auth.uid(), who_name, 'price_set',
                  jsonb_build_object('order_no', op->>'order_no', 'type', op->>'gtype', 'price', amt, 'device_time', ts));

      elsif kind = 'payment' then
        if not exists (select 1 from payments where id = pid) then
          amt := (op->>'amount')::numeric;
          if amt <= 0 or amt > 1000000000 then raise exception 'Invalid amount'; end if;
          select * into o_row from orders where id = (op->>'order_id')::uuid and business_id = p_business;
          if not found then raise exception 'Order not found'; end if;
          insert into payments(id, business_id, order_id, amount_ugx, method, txn_id, comment, receipt_no, recorded_by, recorded_by_name, at)
            values (pid, p_business, o_row.id, round(amt), left(coalesce(op->>'method','Other'),40),
                    nullif(left(coalesce(op->>'txn',''),80),''), nullif(left(coalesce(op->>'comment',''),300),''),
                    left(op->>'receipt_no',40), auth.uid(), who_name, ts);
          insert into audit_events(business_id, branch_id, actor, who, action, detail)
            values (p_business, o_row.branch_id, auth.uid(), who_name, 'payment_received',
                    jsonb_build_object('order_no', o_row.order_no, 'amount', round(amt), 'method', op->>'method', 'receipt', op->>'receipt_no', 'device_time', ts));
        end if;

      elsif kind = 'reverse' then
        if not exists (select 1 from payments where id = pid) then
          select * into p_row from payments where id = (op->>'payment_id')::uuid and business_id = p_business;
          if not found then raise exception 'Payment not found'; end if;
          if p_row.amount_ugx <= 0 then raise exception 'Only a payment can be reversed'; end if;
          if exists (select 1 from payments where reversal_of = p_row.id) then raise exception 'This payment was already reversed'; end if;
          insert into payments(id, business_id, order_id, amount_ugx, method, comment, reversal_of, recorded_by, recorded_by_name, at)
            values (pid, p_business, p_row.order_id, -p_row.amount_ugx, p_row.method,
                    'Reversal of ' || coalesce(p_row.receipt_no,''), p_row.id, auth.uid(), who_name, ts);
          insert into audit_events(business_id, actor, who, action, detail)
            values (p_business, auth.uid(), who_name, 'payment_reversed',
                    jsonb_build_object('receipt', p_row.receipt_no, 'amount', p_row.amount_ugx, 'device_time', ts));
        end if;

      elsif kind = 'expense' then
        if not exists (select 1 from expenses where id = pid) then
          amt := (op->>'amount')::numeric;
          if amt <= 0 or amt > 1000000000 then raise exception 'Invalid amount'; end if;
          if not exists (select 1 from branches where id = (op->>'branch_id')::uuid and business_id = p_business) then raise exception 'Shop not found'; end if;
          insert into expenses(id, business_id, branch_id, spent_on, category, amount_ugx, method, description, recorded_by)
            values (pid, p_business, (op->>'branch_id')::uuid, (op->>'spent_on')::date, left(coalesce(op->>'category','Other'),60),
                    round(amt), left(coalesce(op->>'method',''),40), left(coalesce(op->>'description',''),300), who_name);
          insert into audit_events(business_id, branch_id, actor, who, action, detail)
            values (p_business, (op->>'branch_id')::uuid, auth.uid(), who_name, 'expense_added',
                    jsonb_build_object('amount', round(amt), 'category', op->>'category', 'device_time', ts));
        end if;

      elsif kind = 'void_expense' then
        update expenses set void_by = who_name, void_at = ts
          where id = (op->>'expense_id')::uuid and business_id = p_business and void_at is null;
        if found then
          insert into audit_events(business_id, actor, who, action, detail)
            values (p_business, auth.uid(), who_name, 'expense_voided', jsonb_build_object('expense', op->>'expense_id', 'device_time', ts));
        end if;

      elsif kind = 'audit' then
        insert into audit_events(business_id, branch_id, actor, who, action, detail)
          values (p_business, nullif(op->>'branch_id','')::uuid, auth.uid(), who_name,
                  left(coalesce(op->>'action','note'),60), coalesce(op->'detail','{}'::jsonb) || jsonb_build_object('device_time', ts));
      else
        raise exception 'Unknown change type';
      end if;

      res := res || jsonb_build_array(jsonb_build_object('id', op->>'id', 'ok', true));
    exception when others then
      res := res || jsonb_build_array(jsonb_build_object('id', op->>'id', 'ok', false, 'error', SQLERRM));
    end;
  end loop;
  return res;
end $$;

revoke execute on function sync_money(uuid, text, jsonb) from public, anon;
grant execute on function sync_money(uuid, text, jsonb) to authenticated;


-- ############ PART 4: One login, super admin, roles, features, plans ############
-- =====================================================================
-- Smart Dobi · UPDATE 5: one login for everyone, platform super admin, roles, features, plans.
-- Run once, AFTER updates 2, 3 and 4. Safe to re-run.
--
-- WHO BECOMES THE SUPER ADMIN?
--   The FIRST account created AFTER this script runs becomes the super admin automatically.
--   So: run this script, then immediately create your own account in the app.
--
--   ALREADY HAVE AN ACCOUNT, or want to be extra safe? Put your email between the quotes in the
--   line marked "CHANGE ME" below BEFORE you run it. Then only that email can ever become the
--   super admin (an existing account is upgraded at once; a new one when it is created).
-- =====================================================================

create table if not exists platform_settings(key text primary key, value text not null default '');
alter table platform_settings enable row level security;               -- no policies: only the functions below can touch it
insert into platform_settings(key, value) values ('super_admin_email', '') on conflict (key) do nothing;
-- CHANGE ME (optional): put your email between the quotes below, e.g. 'ann@example.com'. Leave '' for "first new account wins".
update platform_settings set value = '' where key = 'super_admin_email';

-- ---- platform roles and what each role may do ----
create table if not exists platform_roles(role text primary key, label text not null);
create table if not exists platform_permissions(role text not null references platform_roles(role) on delete cascade, permission text not null, primary key(role, permission));
alter table platform_roles enable row level security; alter table platform_permissions enable row level security;
insert into platform_roles(role, label) values ('super_admin','Super admin'), ('support','Support (view only)') on conflict (role) do nothing;
insert into platform_permissions(role, permission) values
  ('super_admin','stats.view'), ('super_admin','businesses.view'), ('super_admin','businesses.manage'), ('super_admin','businesses.suspend'),
  ('super_admin','plans.edit'), ('super_admin','features.edit'), ('super_admin','team.manage'), ('super_admin','audit.view'),
  ('support','stats.view'), ('support','businesses.view'), ('support','audit.view')
  on conflict do nothing;

create table if not exists platform_admins(
  user_id uuid primary key references auth.users(id) on delete cascade, role text not null references platform_roles(role),
  added_by uuid, created_at timestamptz not null default now());
alter table platform_admins enable row level security;                 -- no policies: only the functions below can touch it

create table if not exists platform_audit(
  id bigserial primary key, actor uuid, actor_email text, action text not null, detail jsonb not null default '{}'::jsonb, at timestamptz not null default now());
alter table platform_audit enable row level security;                  -- no policies

-- ---- features catalogue (what a plan can include) ----
create table if not exists features(key text primary key, name text not null, description text not null default '', sort int not null default 0);
alter table features enable row level security;
drop policy if exists features_read on features;
create policy features_read on features for select using (true);
insert into features(key, name, description, sort) values
  ('directory',   'Public Dobi directory', 'Shop can be listed and found by customers in the public directory.', 1),
  ('sms',         'SMS to customers',      'Send tracking links and receipts through the phone''s SMS app.', 2),
  ('reports',     'Printable reports',     'Sales, collections, expenses and status reports.', 3),
  ('expenses',    'Expenses',              'Record and report operating expenses.', 4),
  ('white_label', 'White-label documents', 'Remove the Smart Dobi footer from receipts (planned).', 5)
  on conflict (key) do nothing;

alter table plans add column if not exists active boolean not null default true;
alter table plans add column if not exists sort int not null default 0;
update plans set sort = case id when 'starter' then 1 when 'growth' then 2 when 'pro' then 3 when 'premium' then 4 else sort end;
update plans set entitlements = '{"directory":true,"sms":false,"reports":true,"expenses":true,"white_label":false}'::jsonb where id = 'starter' and entitlements = '{"white_label": false}'::jsonb;
update plans set entitlements = '{"directory":true,"sms":true,"reports":true,"expenses":true,"white_label":false}'::jsonb where id in ('growth','pro') and entitlements = '{"white_label": false}'::jsonb;
update plans set entitlements = '{"directory":true,"sms":true,"reports":true,"expenses":true,"white_label":true}'::jsonb where id = 'premium' and entitlements = '{"white_label": true}'::jsonb;

-- ---- a business can be suspended by the platform ----
alter table businesses add column if not exists status text not null default 'active';
alter table businesses add column if not exists suspended_reason text;
alter table businesses add column if not exists suspended_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_status_check') then
    alter table businesses add constraint businesses_status_check check (status in ('active','suspended'));
  end if;
end $$;

-- a suspended business loses all access at the database level
create or replace function my_role(b uuid) returns app_role language sql stable security definer set search_path = public as
$$ select m.role from memberships m join businesses bz on bz.id = m.business_id
   where m.user_id = auth.uid() and m.business_id = b and m.active and bz.status = 'active' $$;
create or replace function can_branch(b uuid, br uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from memberships m join businesses bz on bz.id = m.business_id
                 where m.user_id = auth.uid() and m.business_id = b and m.active and bz.status = 'active'
                   and (m.branch_id is null or m.branch_id = br)) $$;

-- ---- who is this person? (used by the single login to decide where to send them) ----
create or replace function my_account() returns jsonb language sql stable security definer set search_path = public as
$$ select jsonb_build_object(
     'user_id', auth.uid(),
     'email', (select email from auth.users where id = auth.uid()),
     'platform_role', (select role from platform_admins where user_id = auth.uid()),
     'business', (select jsonb_build_object('id', b.id, 'name', b.name, 'status', b.status, 'suspended_reason', b.suspended_reason, 'plan_id', b.plan_id)
                  from memberships m join businesses b on b.id = m.business_id where m.user_id = auth.uid() and m.active limit 1),
     'features', (select coalesce(p.entitlements, '{}'::jsonb)
                  from memberships m join businesses b on b.id = m.business_id join plans p on p.id = b.plan_id
                  where m.user_id = auth.uid() and m.active limit 1)) $$;

create or replace function has_perm(p text) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from platform_admins a join platform_permissions pp on pp.role = a.role where a.user_id = auth.uid() and pp.permission = p) $$;

create or replace function pa_log(p_action text, p_detail jsonb) returns void language sql security definer set search_path = public as
$$ insert into platform_audit(actor, actor_email, action, detail) values (auth.uid(), (select email from auth.users where id = auth.uid()), p_action, coalesce(p_detail, '{}'::jsonb)) $$;

-- ---- the FIRST new account becomes super admin ----
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare pinned text;
begin
  if not exists (select 1 from platform_admins where role = 'super_admin') then
    select value into pinned from platform_settings where key = 'super_admin_email';
    if coalesce(pinned, '') = '' or lower(new.email) = lower(pinned) then
      insert into platform_admins(user_id, role) values (new.id, 'super_admin');
      insert into platform_audit(actor, actor_email, action, detail) values (new.id, new.email, 'super_admin_created', '{}'::jsonb);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- if you pinned an email and that account already exists, upgrade it now
do $$ declare e text; uid uuid;
begin
  select value into e from platform_settings where key = 'super_admin_email';
  if coalesce(e, '') <> '' and not exists (select 1 from platform_admins where role = 'super_admin') then
    select id into uid from auth.users where lower(email) = lower(e);
    if uid is not null then
      insert into platform_admins(user_id, role) values (uid, 'super_admin') on conflict do nothing;
      insert into platform_audit(actor, actor_email, action, detail) values (uid, e, 'super_admin_created', '{}'::jsonb);
    end if;
  end if;
end $$;

-- ---- platform console functions (each one checks the caller's permission) ----
create or replace function admin_stats() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('stats.view') then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'businesses', (select count(*) from businesses),
    'active', (select count(*) from businesses where status = 'active'),
    'suspended', (select count(*) from businesses where status = 'suspended'),
    'new_7d', (select count(*) from businesses where created_at > now() - interval '7 days'),
    'branches', (select count(*) from branches),
    'orders', (select count(*) from orders),
    'orders_7d', (select count(*) from orders where created_at > now() - interval '7 days'),
    'by_plan', (select coalesce(jsonb_object_agg(plan_id, n), '{}'::jsonb) from (select plan_id, count(*) n from businesses group by plan_id) t));
end $$;

create or replace function admin_list_businesses() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('businesses.view') then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'owner_name', b.owner_name, 'plan_id', b.plan_id, 'status', b.status, 'suspended_reason', b.suspended_reason,
      'created_at', b.created_at,
      'owner_email', (select u.email from memberships m join auth.users u on u.id = m.user_id where m.business_id = b.id and m.role = 'owner' limit 1),
      'branches', (select count(*) from branches x where x.business_id = b.id),
      'orders', (select count(*) from orders o where o.business_id = b.id)) order by b.created_at desc), '[]'::jsonb)
    from businesses b);
end $$;

create or replace function admin_set_plan(p_business uuid, p_plan text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('businesses.manage') then raise exception 'Not allowed'; end if;
  if not exists (select 1 from plans where id = p_plan) then raise exception 'Unknown plan'; end if;
  update businesses set plan_id = p_plan where id = p_business;
  if not found then raise exception 'Business not found'; end if;
  perform pa_log('business_plan_changed', jsonb_build_object('business', p_business, 'plan', p_plan));
end $$;

create or replace function admin_set_status(p_business uuid, p_status text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('businesses.suspend') then raise exception 'Not allowed'; end if;
  if p_status not in ('active','suspended') then raise exception 'Invalid status'; end if;
  if p_status = 'suspended' and length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Enter a reason for suspending'; end if;
  update businesses set status = p_status, suspended_reason = case when p_status = 'suspended' then left(trim(p_reason),300) else null end,
    suspended_at = case when p_status = 'suspended' then now() else null end where id = p_business;
  if not found then raise exception 'Business not found'; end if;
  perform pa_log(case when p_status = 'suspended' then 'business_suspended' else 'business_reactivated' end, jsonb_build_object('business', p_business, 'reason', p_reason));
end $$;

create or replace function admin_save_plan(p jsonb) returns void language plpgsql security definer set search_path = public as $$
declare pid text := p->>'id'; ent jsonb := coalesce(p->'entitlements', '{}'::jsonb); k text;
begin
  if not has_perm('plans.edit') then raise exception 'Not allowed'; end if;
  if pid !~ '^[a-z0-9_-]{2,30}$' then raise exception 'Plan id must be 2-30 lowercase letters, numbers, - or _'; end if;
  if length(trim(coalesce(p->>'name',''))) < 2 then raise exception 'Enter a plan name'; end if;
  if (p->>'price_ugx')::numeric < 0 then raise exception 'Price cannot be negative'; end if;
  if (p->>'max_branches')::int < 1 or (p->>'max_workers_per_branch')::int < 1 then raise exception 'Limits must be at least 1'; end if;
  if (p->>'retention_hours')::int < 1 then raise exception 'Retention must be at least 1 hour'; end if;
  if jsonb_typeof(ent) <> 'object' then raise exception 'Invalid features'; end if;
  for k in select jsonb_object_keys(ent) loop
    if not exists (select 1 from features where key = k) then raise exception 'Unknown feature %', k; end if;
    if jsonb_typeof(ent->k) <> 'boolean' then raise exception 'Feature values must be on or off'; end if;
  end loop;
  insert into plans(id, name, price_ugx, max_branches, max_workers_per_branch, retention_hours, entitlements, active, sort)
    values (pid, trim(p->>'name'), (p->>'price_ugx')::int, (p->>'max_branches')::int, (p->>'max_workers_per_branch')::int,
            (p->>'retention_hours')::int, ent, coalesce((p->>'active')::boolean, true), coalesce((p->>'sort')::int, 0))
  on conflict (id) do update set name = excluded.name, price_ugx = excluded.price_ugx, max_branches = excluded.max_branches,
    max_workers_per_branch = excluded.max_workers_per_branch, retention_hours = excluded.retention_hours,
    entitlements = excluded.entitlements, active = excluded.active, sort = excluded.sort;
  perform pa_log('plan_saved', jsonb_build_object('plan', pid, 'price', p->>'price_ugx', 'features', ent));
end $$;

create or replace function admin_save_feature(p_key text, p_name text, p_description text, p_sort int) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('features.edit') then raise exception 'Not allowed'; end if;
  if p_key !~ '^[a-z0-9_]{2,30}$' then raise exception 'Feature key: 2-30 lowercase letters, numbers or _'; end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Enter a feature name'; end if;
  insert into features(key, name, description, sort) values (p_key, trim(p_name), left(coalesce(p_description,''),300), coalesce(p_sort,0))
  on conflict (key) do update set name = excluded.name, description = excluded.description, sort = excluded.sort;
  perform pa_log('feature_saved', jsonb_build_object('feature', p_key));
end $$;

create or replace function admin_list_team() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('team.manage') then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email, 'role', a.role, 'created_at', a.created_at) order by a.created_at), '[]'::jsonb)
          from platform_admins a join auth.users u on u.id = a.user_id);
end $$;

create or replace function admin_add_team(p_email text, p_role text) returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not has_perm('team.manage') then raise exception 'Not allowed'; end if;
  if not exists (select 1 from platform_roles where role = p_role) then raise exception 'Unknown role'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No account with that email. Ask them to create an account first.'; end if;
  if p_role <> 'super_admin' and exists (select 1 from platform_admins where user_id = uid and role = 'super_admin')
     and (select count(*) from platform_admins where role = 'super_admin') <= 1 then raise exception 'There must always be one super admin'; end if;
  insert into platform_admins(user_id, role, added_by) values (uid, p_role, auth.uid())
  on conflict (user_id) do update set role = excluded.role;
  perform pa_log('team_member_set', jsonb_build_object('email', p_email, 'role', p_role));
end $$;

create or replace function admin_remove_team(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('team.manage') then raise exception 'Not allowed'; end if;
  if p_user = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  if exists (select 1 from platform_admins where user_id = p_user and role = 'super_admin') and (select count(*) from platform_admins where role = 'super_admin') <= 1
    then raise exception 'There must always be one super admin'; end if;
  delete from platform_admins where user_id = p_user;
  perform pa_log('team_member_removed', jsonb_build_object('user', p_user));
end $$;

create or replace function admin_audit() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('audit.view') then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(t) order by t.at desc), '[]'::jsonb) from (select id, actor_email, action, detail, at from platform_audit order by at desc limit 200) t);
end $$;

-- ---- the public directory now respects the plan's "directory" feature and suspension ----
create or replace function search_dobis(p_q text default '', p_area text default '', p_services text[] default '{}', p_pickup boolean default false)
returns table(branch_id uuid, shop_name text, area text, address text, services text[], pickup_delivery boolean, hours text, about text, phone text, email text)
language sql stable security definer set search_path = public as
$$ select br.id,
     bz.name || case when (select count(*) from branches x where x.business_id = bz.id and x.listed) > 1 then ' · ' || br.name else '' end,
     br.area, br.address, br.services, br.pickup_delivery, br.hours, br.about, bz.phone, bz.email
   from branches br join businesses bz on bz.id = br.business_id join plans pl on pl.id = bz.plan_id
   where br.listed and bz.status = 'active' and coalesce((pl.entitlements->>'directory')::boolean, false)
     and (p_q = '' or (bz.name || ' ' || br.name || ' ' || coalesce(br.area,'') || ' ' || array_to_string(br.services,' ')) ilike '%' || p_q || '%')
     and (p_area = '' or br.area = p_area) and br.services @> p_services and (not p_pickup or br.pickup_delivery) $$;
create or replace function get_dobi(p_branch uuid)
returns table(branch_id uuid, shop_name text, area text, address text, services text[], pickup_delivery boolean, hours text, about text, phone text, email text)
language sql stable security definer set search_path = public as
$$ select br.id,
     bz.name || case when (select count(*) from branches x where x.business_id = bz.id and x.listed) > 1 then ' · ' || br.name else '' end,
     br.area, br.address, br.services, br.pickup_delivery, br.hours, br.about, bz.phone, bz.email
   from branches br join businesses bz on bz.id = br.business_id join plans pl on pl.id = bz.plan_id
   where br.id = p_branch and br.listed and bz.status = 'active' and coalesce((pl.entitlements->>'directory')::boolean, false) $$;

-- ---- who may call what ----
revoke execute on function my_account(), has_perm(text), pa_log(text, jsonb), admin_stats(), admin_list_businesses(), admin_set_plan(uuid, text),
  admin_set_status(uuid, text, text), admin_save_plan(jsonb), admin_save_feature(text, text, text, int), admin_list_team(),
  admin_add_team(text, text), admin_remove_team(uuid), admin_audit() from public, anon;
grant execute on function my_account(), admin_stats(), admin_list_businesses(), admin_set_plan(uuid, text), admin_set_status(uuid, text, text),
  admin_save_plan(jsonb), admin_save_feature(text, text, text, int), admin_list_team(), admin_add_team(text, text), admin_remove_team(uuid), admin_audit() to authenticated;
grant execute on function search_dobis(text, text, text[], boolean), get_dobi(uuid) to anon, authenticated;
-- internal helpers: only other database functions may call these, never a browser
revoke execute on function has_perm(text), pa_log(text, jsonb), handle_new_user() from public, anon, authenticated;


-- ############ PART 5: Free plan, payments, pickup orders, support, activity, photo clearing ############
-- =====================================================================
-- Smart Dobi · UPDATE 6: free default plan, expiry + upgrade payments, pickup orders,
-- support messages, activity analytics, and plan-controlled photo clearing.
-- Run once, AFTER updates 1-5. Safe to re-run.
-- =====================================================================

-- ---------- A. a business can now be 'restricted' (plan expired) and a plan can expire ----------
alter table businesses drop constraint if exists businesses_status_check;
alter table businesses add constraint businesses_status_check check (status in ('active','restricted','suspended'));
alter table businesses add column if not exists plan_expires_at timestamptz;

-- ---------- B. the Free plan (price 0) and the default plan for new accounts ----------
insert into plans(id, name, price_ugx, max_branches, max_workers_per_branch, retention_hours, entitlements, active, sort)
values ('free', 'Free plan', 0, 1, 2, 24, '{"directory":true,"sms":false,"reports":false,"expenses":false,"white_label":false}'::jsonb, true, 0)
on conflict (id) do nothing;
insert into platform_settings(key, value) values ('default_plan', 'free') on conflict (key) do nothing;

-- ---------- C. effective status, access rules, account info ----------
create or replace function biz_effective_status(bz businesses) returns text language sql stable as
$$ select case when bz.status = 'suspended' then 'suspended'
               when bz.status = 'restricted' or (bz.plan_expires_at is not null and bz.plan_expires_at <= now()) then 'restricted'
               else 'active' end $$;

create or replace function my_role(b uuid) returns app_role language sql stable security definer set search_path = public as
$$ select m.role from memberships m join businesses bz on bz.id = m.business_id
   where m.user_id = auth.uid() and m.business_id = b and m.active and bz.status = 'active'
     and (bz.plan_expires_at is null or bz.plan_expires_at > now()) $$;
create or replace function can_branch(b uuid, br uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from memberships m join businesses bz on bz.id = m.business_id
                 where m.user_id = auth.uid() and m.business_id = b and m.active and bz.status = 'active'
                   and (bz.plan_expires_at is null or bz.plan_expires_at > now())
                   and (m.branch_id is null or m.branch_id = br)) $$;

create or replace function my_account() returns jsonb language sql stable security definer set search_path = public as
$$ select jsonb_build_object(
     'user_id', auth.uid(),
     'email', (select email from auth.users where id = auth.uid()),
     'platform_role', (select role from platform_admins where user_id = auth.uid()),
     'business', (select jsonb_build_object('id', b.id, 'name', b.name, 'status', biz_effective_status(b), 'suspended_reason', b.suspended_reason,
                         'plan_id', b.plan_id, 'plan_expires_at', b.plan_expires_at)
                  from memberships m join businesses b on b.id = m.business_id where m.user_id = auth.uid() and m.active limit 1),
     'features', (select coalesce(p.entitlements, '{}'::jsonb)
                  from memberships m join businesses b on b.id = m.business_id join plans p on p.id = b.plan_id
                  where m.user_id = auth.uid() and m.active limit 1)) $$;

-- new accounts start on the default plan (Free unless the super admin changes it); one business per account
create or replace function create_business(p_name text, p_owner text, p_branch text, p_admin_pin text, p_branch_pin text, p_phone text, p_email text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare nb uuid; dp text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from memberships where user_id = auth.uid()) then raise exception 'This account already has a business'; end if;
  if p_admin_pin !~ '^[0-9]{4,5}$' or p_branch_pin !~ '^[0-9]{4,5}$' then raise exception 'PINs must be 4 or 5 digits'; end if;
  select value into dp from platform_settings where key = 'default_plan';
  if dp is null or not exists (select 1 from plans where id = dp) then dp := 'free'; end if;
  insert into businesses(name, owner_name, phone, email, admin_pin_hash, plan_id)
    values (p_name, p_owner, p_phone, p_email, crypt(p_admin_pin, gen_salt('bf')), dp) returning id into nb;
  insert into branches(business_id, name, pin_hash) values (nb, p_branch, crypt(p_branch_pin, gen_salt('bf')));
  insert into memberships(user_id, business_id, role) values (auth.uid(), nb, 'owner');
  return nb;
end $$;

-- ---------- D. upgrade payments (mobile money, proof, approval) ----------
create table if not exists payment_methods(
  id text primary key, label text not null, code text not null default '', account_name text not null default '',
  active boolean not null default true, sort int not null default 0);
alter table payment_methods enable row level security;                  -- no policies: functions only
insert into payment_methods(id, label, code, account_name, sort) values
  ('mtn', 'MTN Mobile Money', '', '', 1), ('airtel', 'Airtel Money', '', '', 2) on conflict (id) do nothing;

create table if not exists subscription_payments(
  id uuid primary key default gen_random_uuid(), business_id uuid not null references businesses(id) on delete cascade,
  plan_id text not null references plans(id), amount_ugx int not null check (amount_ugx >= 0), method text not null,
  paying_number text not null, txn_id text not null, proof_path text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')), reject_reason text,
  created_by uuid, created_at timestamptz not null default now(), reviewed_by uuid, reviewed_at timestamptz);
alter table subscription_payments enable row level security;            -- no policies: functions only
create index if not exists subpay_business on subscription_payments(business_id, created_at desc);

create or replace function payment_info() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare bid uuid;
begin
  select m.business_id into bid from memberships m where m.user_id = auth.uid() and m.active limit 1;
  if bid is null then raise exception 'No business on this account'; end if;
  return jsonb_build_object(
    'business', (select jsonb_build_object('id', b.id, 'name', b.name, 'status', biz_effective_status(b), 'plan_id', b.plan_id, 'plan_expires_at', b.plan_expires_at) from businesses b where b.id = bid),
    'methods', (select coalesce(jsonb_agg(jsonb_build_object('id', pm.id, 'label', pm.label, 'code', pm.code, 'account_name', pm.account_name) order by pm.sort), '[]'::jsonb) from payment_methods pm where pm.active),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('id', pl.id, 'name', pl.name, 'price_ugx', pl.price_ugx, 'max_branches', pl.max_branches,
                'max_workers_per_branch', pl.max_workers_per_branch, 'retention_hours', pl.retention_hours, 'entitlements', pl.entitlements) order by pl.sort), '[]'::jsonb)
              from plans pl where pl.active and pl.price_ugx > 0),
    'latest', (select to_jsonb(t) from (select sp.id, sp.plan_id, sp.amount_ugx, sp.method, sp.txn_id, sp.status, sp.reject_reason, sp.created_at
                                        from subscription_payments sp where sp.business_id = bid order by sp.created_at desc limit 1) t));
end $$;

create or replace function submit_payment(p_id uuid, p_plan text, p_method text, p_number text, p_txn text, p_proof text)
returns void language plpgsql security definer set search_path = public as $$
declare bid uuid; pr plans%rowtype;
begin
  select m.business_id into bid from memberships m where m.user_id = auth.uid() and m.active limit 1;
  if bid is null then raise exception 'No business on this account'; end if;
  select * into pr from plans where id = p_plan and active and price_ugx > 0;
  if not found then raise exception 'Choose a plan to pay for'; end if;
  if not exists (select 1 from payment_methods where id = p_method and active) then raise exception 'Choose how you paid'; end if;
  if length(regexp_replace(coalesce(p_number,''), '[^0-9]', '', 'g')) < 9 then raise exception 'Enter the number you paid from'; end if;
  if length(trim(coalesce(p_txn,''))) < 4 or length(trim(p_txn)) > 40 then raise exception 'Enter the transaction ID from your payment message'; end if;
  if p_proof is null or left(p_proof, length(bid::text) + 1) <> bid::text || '/' then raise exception 'Upload a screenshot or photo of your payment receipt'; end if;
  if exists (select 1 from subscription_payments where business_id = bid and status = 'pending') then raise exception 'You already have a payment waiting for approval'; end if;
  insert into subscription_payments(id, business_id, plan_id, amount_ugx, method, paying_number, txn_id, proof_path, created_by)
    values (p_id, bid, pr.id, pr.price_ugx, p_method, left(trim(p_number),20), left(trim(p_txn),40), left(p_proof,160), auth.uid());
  insert into audit_events(business_id, actor, who, action, detail)
    values (bid, auth.uid(), 'Shop owner', 'upgrade_requested', jsonb_build_object('plan', pr.id, 'amount', pr.price_ugx));
end $$;

create or replace function admin_list_payments(p_status text default 'pending') returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('payments.review') then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', sp.id, 'business_id', sp.business_id, 'business', b.name,
            'owner_email', (select u.email from memberships m join auth.users u on u.id = m.user_id where m.business_id = b.id and m.role = 'owner' limit 1),
            'plan_id', sp.plan_id, 'plan_name', pl.name, 'amount_ugx', sp.amount_ugx, 'method', sp.method, 'paying_number', sp.paying_number,
            'txn_id', sp.txn_id, 'proof_path', sp.proof_path, 'status', sp.status, 'reject_reason', sp.reject_reason,
            'created_at', sp.created_at, 'reviewed_at', sp.reviewed_at) order by sp.created_at desc), '[]'::jsonb)
          from (select * from subscription_payments x where p_status = 'all' or x.status = p_status order by x.created_at desc limit 200) sp
          join businesses b on b.id = sp.business_id join plans pl on pl.id = sp.plan_id);
end $$;

create or replace function admin_review_payment(p_id uuid, p_approve boolean, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare sp subscription_payments%rowtype;
begin
  if not has_perm('payments.review') then raise exception 'Not allowed'; end if;
  select * into sp from subscription_payments where id = p_id;
  if not found then raise exception 'Payment not found'; end if;
  if sp.status <> 'pending' then raise exception 'This payment was already reviewed'; end if;
  if p_approve then
    update businesses set plan_id = sp.plan_id,
        plan_expires_at = greatest(coalesce(plan_expires_at, now()), now()) + interval '30 days',
        suspended_reason = case when status = 'restricted' then null else suspended_reason end,
        status = case when status = 'restricted' then 'active' else status end
      where id = sp.business_id;
    update subscription_payments set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    insert into audit_events(business_id, actor, who, action, detail)
      values (sp.business_id, auth.uid(), 'Smart Dobi', 'subscription_approved', jsonb_build_object('plan', sp.plan_id, 'amount', sp.amount_ugx));
    perform pa_log('payment_approved', jsonb_build_object('payment', p_id, 'business', sp.business_id, 'plan', sp.plan_id));
  else
    if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Enter a reason for rejecting'; end if;
    update subscription_payments set status = 'rejected', reject_reason = left(trim(p_reason),300), reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    insert into audit_events(business_id, actor, who, action, detail)
      values (sp.business_id, auth.uid(), 'Smart Dobi', 'subscription_rejected', jsonb_build_object('plan', sp.plan_id, 'reason', left(trim(p_reason),300)));
    perform pa_log('payment_rejected', jsonb_build_object('payment', p_id, 'business', sp.business_id, 'reason', p_reason));
  end if;
end $$;

create or replace function admin_get_payment_methods() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('payments.review') then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(pm) order by pm.sort), '[]'::jsonb) from payment_methods pm);
end $$;
create or replace function admin_save_payment_method(p_id text, p_label text, p_code text, p_account_name text, p_active boolean, p_sort int) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('payments.settings') then raise exception 'Not allowed'; end if;
  if p_id !~ '^[a-z0-9_]{2,20}$' then raise exception 'Method id: 2-20 lowercase letters, numbers or _'; end if;
  if length(trim(coalesce(p_label,''))) < 2 then raise exception 'Enter a name for this method'; end if;
  insert into payment_methods(id, label, code, account_name, active, sort)
    values (p_id, trim(p_label), left(trim(coalesce(p_code,'')),40), left(trim(coalesce(p_account_name,'')),80), coalesce(p_active,true), coalesce(p_sort,0))
  on conflict (id) do update set label = excluded.label, code = excluded.code, account_name = excluded.account_name, active = excluded.active, sort = excluded.sort;
  perform pa_log('payment_method_saved', jsonb_build_object('method', p_id));
end $$;

-- ---------- E. subscriptions list, default plan, stats ----------
create or replace function admin_list_subscriptions() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('subscriptions.view') then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name,
      'owner_email', (select u.email from memberships m join auth.users u on u.id = m.user_id where m.business_id = b.id and m.role = 'owner' limit 1),
      'plan_id', b.plan_id, 'plan_name', pl.name, 'price_ugx', pl.price_ugx, 'status', biz_effective_status(b), 'reason', b.suspended_reason,
      'plan_expires_at', b.plan_expires_at, 'created_at', b.created_at,
      'last_payment', (select jsonb_build_object('status', sp.status, 'at', sp.created_at) from subscription_payments sp where sp.business_id = b.id order by sp.created_at desc limit 1)
    ) order by b.created_at desc), '[]'::jsonb)
    from businesses b join plans pl on pl.id = b.plan_id);
end $$;

create or replace function admin_set_status(p_business uuid, p_status text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('businesses.suspend') then raise exception 'Not allowed'; end if;
  if p_status not in ('active','restricted','suspended') then raise exception 'Invalid status'; end if;
  if p_status = 'suspended' and length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Enter a reason for suspending'; end if;
  update businesses set status = p_status,
      suspended_reason = case when p_status = 'active' then null
                              when p_status = 'restricted' then coalesce(nullif(left(trim(coalesce(p_reason,'')),300),''), 'Plan expired')
                              else left(trim(p_reason),300) end,
      suspended_at = case when p_status = 'active' then null else now() end,
      plan_expires_at = case when p_status = 'active' and plan_expires_at is not null and plan_expires_at <= now() then now() + interval '30 days' else plan_expires_at end
    where id = p_business;
  if not found then raise exception 'Business not found'; end if;
  perform pa_log('business_' || p_status, jsonb_build_object('business', p_business, 'reason', p_reason));
end $$;

create or replace function admin_default_plan() returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('stats.view') then raise exception 'Not allowed'; end if;
  return coalesce((select value from platform_settings where key = 'default_plan'), 'free');
end $$;
create or replace function admin_set_default_plan(p_plan text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('plans.edit') then raise exception 'Not allowed'; end if;
  if not exists (select 1 from plans where id = p_plan and active) then raise exception 'Choose an active plan'; end if;
  insert into platform_settings(key, value) values ('default_plan', p_plan) on conflict (key) do update set value = excluded.value;
  perform pa_log('default_plan_set', jsonb_build_object('plan', p_plan));
end $$;

create or replace function admin_stats() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('stats.view') then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'businesses', (select count(*) from businesses),
    'active', (select count(*) from businesses b where biz_effective_status(b) = 'active'),
    'restricted', (select count(*) from businesses b where biz_effective_status(b) = 'restricted'),
    'suspended', (select count(*) from businesses b where biz_effective_status(b) = 'suspended'),
    'new_7d', (select count(*) from businesses where created_at > now() - interval '7 days'),
    'branches', (select count(*) from branches),
    'orders', (select count(*) from orders),
    'orders_7d', (select count(*) from orders where created_at > now() - interval '7 days'),
    'pending_payments', (select count(*) from subscription_payments where status = 'pending'),
    'new_messages', (select count(*) from platform_messages where status = 'new'),
    'by_plan', (select coalesce(jsonb_object_agg(plan_id, n), '{}'::jsonb) from (select plan_id, count(*) n from businesses group by plan_id) t));
end $$;

-- ---------- F. support and partner messages ----------
create table if not exists platform_messages(
  id uuid primary key default gen_random_uuid(), kind text not null check (kind in ('support','partner')),
  name text, email text, phone text, message text not null, status text not null default 'new' check (status in ('new','resolved')),
  business_id uuid, created_at timestamptz not null default now(), resolved_by uuid, resolved_at timestamptz);
alter table platform_messages enable row level security;                -- no policies: functions only

create or replace function submit_support(p_kind text, p_name text, p_email text, p_phone text, p_message text) returns void language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(coalesce(p_email,''))); ph text := regexp_replace(coalesce(p_phone,''), '[^0-9+]', '', 'g'); bid uuid;
begin
  if p_kind not in ('support','partner') then raise exception 'Invalid message type'; end if;
  if length(trim(coalesce(p_message,''))) < 5 or length(p_message) > 2000 then raise exception 'Write a message of 5 to 2000 characters'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then em := ''; end if;
  if length(regexp_replace(ph, '[^0-9]', '', 'g')) < 7 then ph := ''; end if;
  if em = '' and ph = '' then raise exception 'Enter an email or phone number so we can reply'; end if;
  if (select count(*) from platform_messages where created_at > now() - interval '1 hour') >= 200 then raise exception 'Please try again later'; end if;
  if em <> '' and (select count(*) from platform_messages where email = em and created_at > now() - interval '1 hour') >= 5 then raise exception 'Too many messages from this email. Please try again later.'; end if;
  select m.business_id into bid from memberships m where m.user_id = auth.uid() and m.active limit 1;
  insert into platform_messages(kind, name, email, phone, message, business_id)
    values (p_kind, nullif(left(trim(coalesce(p_name,'')),80),''), nullif(em,''), nullif(left(ph,20),''), left(trim(p_message),2000), bid);
end $$;

create or replace function admin_list_messages(p_status text default 'new') returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm('messages.view') then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'name', x.name, 'email', x.email, 'phone', x.phone, 'message', x.message,
            'status', x.status, 'created_at', x.created_at, 'business', (select b.name from businesses b where b.id = x.business_id)) order by x.created_at desc), '[]'::jsonb)
          from (select * from platform_messages m where p_status = 'all' or m.status = p_status order by m.created_at desc limit 200) x);
end $$;
create or replace function admin_resolve_message(p_id uuid, p_resolved boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('messages.resolve') then raise exception 'Not allowed'; end if;
  update platform_messages set status = case when p_resolved then 'resolved' else 'new' end,
      resolved_by = case when p_resolved then auth.uid() else null end, resolved_at = case when p_resolved then now() else null end where id = p_id;
  perform pa_log('message_' || case when p_resolved then 'resolved' else 'reopened' end, jsonb_build_object('message', p_id));
end $$;

-- ---------- G. activity analytics: who is active and who is not ----------
create or replace function admin_activity(p_days int default 30) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d int := least(greatest(coalesce(p_days, 30), 1), 365);
begin
  if not has_perm('activity.view') then raise exception 'Not allowed'; end if;
  return jsonb_build_object('days', d,
    'by_business', (select coalesce(jsonb_agg(s.x order by (s.x->>'events')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('id', b.id, 'name', b.name, 'plan_id', b.plan_id, 'status', biz_effective_status(b),
          'events', (select count(*) from audit_events e where e.business_id = b.id and e.at > now() - make_interval(days => d)),
          'last_event', (select max(e.at) from audit_events e where e.business_id = b.id),
          'people', (select coalesce(jsonb_agg(distinct e.who), '[]'::jsonb) from audit_events e where e.business_id = b.id and e.at > now() - make_interval(days => d) and coalesce(e.who, '') <> ''),
          'orders', (select count(*) from orders o where o.business_id = b.id and o.created_at > now() - make_interval(days => d))) as x
        from businesses b) s),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', t.day, 'events', t.n) order by t.day), '[]'::jsonb)
              from (select date_trunc('day', e.at)::date as day, count(*) as n from audit_events e where e.at > now() - make_interval(days => d) group by 1) t),
    'top_actions', (select coalesce(jsonb_agg(jsonb_build_object('action', t.action, 'n', t.n) order by t.n desc), '[]'::jsonb)
              from (select e.action, count(*) as n from audit_events e where e.at > now() - make_interval(days => d) and e.action not like 'wrong%' group by e.action order by n desc limit 10) t));
end $$;

-- ---------- H. customer pickup orders ----------
alter table requests alter column phone drop not null;
alter table requests add column if not exists items jsonb;
alter table requests add column if not exists contact_email text;
alter table requests add column if not exists contact_whatsapp text;
alter table requests add column if not exists contact_sms text;
alter table requests add column if not exists decline_reason text;
alter table requests add column if not exists photos_purged_at timestamptz;
alter table requests drop constraint if exists requests_kind_check;
alter table requests add constraint requests_kind_check check (kind in ('pkg','cb','pickup'));
alter table orders add column if not exists source text not null default 'shop';
alter table orders add column if not exists request_id uuid;
alter table orders drop constraint if exists orders_source_check;
alter table orders add constraint orders_source_check check (source in ('shop','pickup'));
alter table garments add column if not exists photos_purged_at timestamptz;

create or replace function dobi_ok(p_branch uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from branches br join businesses bz on bz.id = br.business_id join plans pl on pl.id = bz.plan_id
   where br.id = p_branch and br.listed and bz.status = 'active' and (bz.plan_expires_at is null or bz.plan_expires_at > now())
     and coalesce((pl.entitlements->>'directory')::boolean, false)) $$;

create or replace function submit_pickup(p_request uuid, p_branch uuid, p_name text, p_email text, p_whatsapp text, p_sms text, p_how text, p_note text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare biz uuid; it jsonb; clean jsonb := '[]'::jsonb; prefix text; ph text;
        wa text := regexp_replace(coalesce(p_whatsapp,''), '[^0-9+]', '', 'g'); sm text := regexp_replace(coalesce(p_sms,''), '[^0-9+]', '', 'g'); em text := lower(trim(coalesce(p_email,'')));
begin
  if not dobi_ok(p_branch) then raise exception 'This shop is not accepting requests right now'; end if;
  select business_id into biz from branches where id = p_branch;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Enter your name'; end if;
  if length(regexp_replace(wa, '[^0-9]', '', 'g')) < 9 then wa := ''; end if;
  if length(regexp_replace(sm, '[^0-9]', '', 'g')) < 9 then sm := ''; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then em := ''; end if;
  if wa = '' and sm = '' and em = '' then raise exception 'Enter at least one way to receive your invoice: email, WhatsApp or SMS number'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then raise exception 'Add between 1 and 30 items'; end if;
  if (select count(*) from requests where branch_id = p_branch and created_at > now() - interval '1 hour') >= 40 then raise exception 'This shop has received many requests. Please try again later.'; end if;
  prefix := 'pickup/' || p_branch::text || '/' || p_request::text || '/';
  for it in select value from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(it->>'type',''))) < 1 then raise exception 'Every item needs a type'; end if;
    ph := nullif(it->>'photo_path', '');
    if ph is not null and (left(ph, length(prefix)) <> prefix or length(ph) > 160) then raise exception 'Invalid photo'; end if;
    clean := clean || jsonb_build_array(jsonb_build_object('type', left(trim(it->>'type'),80), 'qty', least(99, greatest(1, coalesce((it->>'qty')::int, 1))),
               'color', left(coalesce(it->>'color',''),60), 'description', left(coalesce(it->>'description',''),300), 'photo_path', ph));
  end loop;
  insert into requests(id, business_id, branch_id, kind, name, phone, note, how, status, items, contact_email, contact_whatsapp, contact_sms)
    values (p_request, biz, p_branch, 'pickup', left(trim(p_name),80), nullif(coalesce(nullif(wa,''), sm),''), left(coalesce(p_note,''),500), left(coalesce(p_how,''),80),
            'new', clean, nullif(em,''), nullif(wa,''), nullif(sm,''));
end $$;

create or replace function process_pickup(p_request uuid, p_items jsonb, p_who text, p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare rq requests%rowtype; cid uuid; ord_id uuid; seq int; ono text; it jsonb; gid uuid; ids jsonb := '[]'::jsonb; prefix text; ph text; pr numeric;
begin
  select * into rq from requests where id = p_request;
  if not found then raise exception 'Request not found'; end if;
  if not can_branch(rq.business_id, rq.branch_id) then raise exception 'Not allowed'; end if;
  if rq.kind <> 'pickup' then raise exception 'This is not a pickup order'; end if;
  if rq.status not in ('new','contacted') then raise exception 'This request was already handled'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 40 then raise exception 'Add at least one item'; end if;
  if length(coalesce(p_token,'')) < 32 then raise exception 'Invalid tracking token'; end if;
  prefix := 'pickup/' || rq.branch_id::text || '/' || rq.id::text || '/';
  update businesses set order_seq = order_seq + 1 where id = rq.business_id returning order_seq into seq;
  ono := 'SD-' || seq::text;
  insert into customers(business_id, name, phone, email) values (rq.business_id, rq.name, coalesce(rq.contact_whatsapp, rq.contact_sms), rq.contact_email) returning id into cid;
  insert into orders(business_id, branch_id, customer_id, order_no, received_by, received_by_name, tracking_token, tracking_token_hash, source, request_id)
    values (rq.business_id, rq.branch_id, cid, ono, auth.uid(), left(coalesce(p_who,''),80), p_token, encode(digest(p_token,'sha256'),'hex'), 'pickup', rq.id) returning id into ord_id;
  for it in select value from jsonb_array_elements(p_items) loop
    ph := nullif(it->>'photo_path', '');
    if ph is not null and left(ph, length(prefix)) <> prefix then raise exception 'Invalid photo'; end if;
    pr := nullif(it->>'price', '')::numeric;
    if pr is not null and (pr < 0 or pr > 100000000) then raise exception 'Invalid price'; end if;
    insert into garments(order_id, business_id, type, qty, color, description, photo_path, unit_price_ugx)
      values (ord_id, rq.business_id, left(coalesce(it->>'type','Item'),80), least(99, greatest(1, coalesce((it->>'qty')::int, 1))),
              left(coalesce(it->>'color',''),60), left(coalesce(it->>'description',''),300), ph, case when pr is null then null else round(pr) end) returning id into gid;
    insert into garment_history(garment_id, status, by_user) values (gid, 'received', auth.uid());
    ids := ids || jsonb_build_array(gid);
  end loop;
  update requests set status = 'converted', order_id = ord_id where id = rq.id;
  insert into audit_events(business_id, branch_id, actor, who, action, detail)
    values (rq.business_id, rq.branch_id, auth.uid(), left(coalesce(p_who,''),80), 'pickup_processed', jsonb_build_object('order_no', ono, 'items', jsonb_array_length(p_items)));
  return jsonb_build_object('order_id', ord_id, 'order_no', ono, 'garment_ids', ids);
end $$;

create or replace function decline_pickup(p_request uuid, p_reason text, p_who text) returns void language plpgsql security definer set search_path = public as $$
declare rq requests%rowtype;
begin
  select * into rq from requests where id = p_request;
  if not found then raise exception 'Request not found'; end if;
  if not can_branch(rq.business_id, rq.branch_id) then raise exception 'Not allowed'; end if;
  if rq.status not in ('new','contacted') then raise exception 'This request was already handled'; end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Enter a reason'; end if;
  update requests set status = 'declined', decline_reason = left(trim(p_reason),300) where id = p_request;
  insert into audit_events(business_id, branch_id, actor, who, action, detail)
    values (rq.business_id, rq.branch_id, auth.uid(), left(coalesce(p_who,''),80), 'pickup_declined', jsonb_build_object('reason', left(trim(p_reason),300)));
end $$;

-- ---------- I. photo clearing, controlled by each plan's "retention_hours" ----------
create or replace function due_photo_deletions(p_business uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare hrs int;
begin
  if my_role(p_business) is null then raise exception 'Not allowed'; end if;
  select pl.retention_hours into hrs from businesses b join plans pl on pl.id = b.plan_id where b.id = p_business;
  hrs := coalesce(hrs, 48);
  return jsonb_build_object('hours', hrs,
    'garments', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'path', t.photo_path)), '[]'::jsonb)
                 from (select g.id, g.photo_path from garments g join orders o on o.id = g.order_id
                       where g.business_id = p_business and g.photo_path is not null and o.closed_at is not null
                         and o.closed_at < now() - make_interval(hours => hrs) limit 200) t),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'paths',
                    (select coalesce(jsonb_agg(x->>'photo_path'), '[]'::jsonb) from jsonb_array_elements(r.items) x where x->>'photo_path' is not null))), '[]'::jsonb)
                 from (select q.id, q.items from requests q
                       where q.business_id = p_business and q.kind = 'pickup' and q.photos_purged_at is null and q.items is not null
                         and ((q.status = 'declined' and q.created_at < now() - make_interval(hours => hrs))
                              or (q.status in ('new','contacted') and q.created_at < now() - interval '30 days'))
                         and exists (select 1 from jsonb_array_elements(q.items) y where y->>'photo_path' is not null) limit 100) r));
end $$;

create or replace function mark_photos_deleted(p_business uuid, p_garments uuid[], p_requests uuid[]) returns void language plpgsql security definer set search_path = public as $$
declare g int := 0; r int := 0;
begin
  if my_role(p_business) is null then raise exception 'Not allowed'; end if;
  update garments set photo_path = null, photos_purged_at = now()
    where business_id = p_business and id = any(coalesce(p_garments, '{}'::uuid[])) and photo_path is not null;
  get diagnostics g = row_count;
  update requests set items = (select coalesce(jsonb_agg(x - 'photo_path'), '[]'::jsonb) from jsonb_array_elements(items) x), photos_purged_at = now()
    where business_id = p_business and id = any(coalesce(p_requests, '{}'::uuid[])) and items is not null;
  get diagnostics r = row_count;
  if g + r > 0 then
    insert into audit_events(business_id, actor, who, action, detail) values (p_business, auth.uid(), 'System', 'photos_cleared', jsonb_build_object('garments', g, 'requests', r));
  end if;
end $$;

-- ---------- J. storage: customer pickup photos, payment proofs, size and type limits ----------
update storage.buckets set file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'] where id = 'garment-photos';
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('payment-proofs', 'payment-proofs', false, 2097152, array['image/jpeg','image/png'])
  on conflict (id) do update set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg','image/png'];

create or replace function pickup_path_ok(p text) returns boolean language sql stable security definer set search_path = public, storage as
$$ select (storage.foldername(p))[1] = 'pickup' and array_length(storage.foldername(p), 1) = 3
          and exists (select 1 from branches b where b.id::text = (storage.foldername(p))[2] and dobi_ok(b.id)) $$;
create or replace function pickup_path_member(p text) returns boolean language sql stable security definer set search_path = public, storage as
$$ select (storage.foldername(p))[1] = 'pickup' and exists (select 1 from branches b join memberships m on m.business_id = b.business_id
          where b.id::text = (storage.foldername(p))[2] and m.user_id = auth.uid() and m.active) $$;
create or replace function is_platform_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from platform_admins where user_id = auth.uid()) $$;

drop policy if exists "sd pickup upload" on storage.objects;
drop policy if exists "sd pickup staff select" on storage.objects;
drop policy if exists "sd pickup staff delete" on storage.objects;
drop policy if exists "sd proofs insert" on storage.objects;
drop policy if exists "sd proofs select" on storage.objects;
create policy "sd pickup upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'garment-photos' and public.pickup_path_ok(name));
create policy "sd pickup staff select" on storage.objects for select to authenticated
  using (bucket_id = 'garment-photos' and public.pickup_path_member(name));
create policy "sd pickup staff delete" on storage.objects for delete to authenticated
  using (bucket_id = 'garment-photos' and public.pickup_path_member(name));
create policy "sd proofs insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-proofs' and exists (select 1 from memberships m where m.user_id = auth.uid() and m.active and m.business_id::text = (storage.foldername(name))[1]));
create policy "sd proofs select" on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs' and (public.is_platform_admin() or exists (select 1 from memberships m where m.user_id = auth.uid() and m.active and m.business_id::text = (storage.foldername(name))[1])));

-- ---------- K. directory functions also respect plan expiry ----------
create or replace function search_dobis(p_q text default '', p_area text default '', p_services text[] default '{}', p_pickup boolean default false)
returns table(branch_id uuid, shop_name text, area text, address text, services text[], pickup_delivery boolean, hours text, about text, phone text, email text)
language sql stable security definer set search_path = public as
$$ select br.id,
     bz.name || case when (select count(*) from branches x where x.business_id = bz.id and x.listed) > 1 then ' · ' || br.name else '' end,
     br.area, br.address, br.services, br.pickup_delivery, br.hours, br.about, bz.phone, bz.email
   from branches br join businesses bz on bz.id = br.business_id join plans pl on pl.id = bz.plan_id
   where br.listed and bz.status = 'active' and (bz.plan_expires_at is null or bz.plan_expires_at > now()) and coalesce((pl.entitlements->>'directory')::boolean, false)
     and (p_q = '' or (bz.name || ' ' || br.name || ' ' || coalesce(br.area,'') || ' ' || array_to_string(br.services,' ')) ilike '%' || p_q || '%')
     and (p_area = '' or br.area = p_area) and br.services @> p_services and (not p_pickup or br.pickup_delivery) $$;
create or replace function get_dobi(p_branch uuid)
returns table(branch_id uuid, shop_name text, area text, address text, services text[], pickup_delivery boolean, hours text, about text, phone text, email text)
language sql stable security definer set search_path = public as
$$ select br.id,
     bz.name || case when (select count(*) from branches x where x.business_id = bz.id and x.listed) > 1 then ' · ' || br.name else '' end,
     br.area, br.address, br.services, br.pickup_delivery, br.hours, br.about, bz.phone, bz.email
   from branches br join businesses bz on bz.id = br.business_id join plans pl on pl.id = bz.plan_id
   where br.id = p_branch and dobi_ok(br.id) $$;

-- ---------- L. new platform permissions ----------
insert into platform_permissions(role, permission) values
  ('super_admin','payments.review'), ('super_admin','payments.settings'), ('super_admin','messages.view'), ('super_admin','messages.resolve'),
  ('super_admin','activity.view'), ('super_admin','subscriptions.view'),
  ('support','messages.view'), ('support','messages.resolve'), ('support','activity.view'), ('support','subscriptions.view')
  on conflict do nothing;

-- ---------- M. who may call what ----------
revoke execute on function biz_effective_status(businesses), dobi_ok(uuid) from public, anon, authenticated;
revoke execute on function payment_info(), submit_payment(uuid, text, text, text, text, text), admin_list_payments(text), admin_review_payment(uuid, boolean, text),
  admin_get_payment_methods(), admin_save_payment_method(text, text, text, text, boolean, int), admin_list_subscriptions(), admin_set_status(uuid, text, text),
  admin_default_plan(), admin_set_default_plan(text), admin_stats(), admin_list_messages(text), admin_resolve_message(uuid, boolean), admin_activity(int),
  process_pickup(uuid, jsonb, text, text), decline_pickup(uuid, text, text), due_photo_deletions(uuid), mark_photos_deleted(uuid, uuid[], uuid[]),
  create_business(text, text, text, text, text, text, text), my_account() from public, anon;
grant execute on function payment_info(), submit_payment(uuid, text, text, text, text, text), admin_list_payments(text), admin_review_payment(uuid, boolean, text),
  admin_get_payment_methods(), admin_save_payment_method(text, text, text, text, boolean, int), admin_list_subscriptions(), admin_set_status(uuid, text, text),
  admin_default_plan(), admin_set_default_plan(text), admin_stats(), admin_list_messages(text), admin_resolve_message(uuid, boolean), admin_activity(int),
  process_pickup(uuid, jsonb, text, text), decline_pickup(uuid, text, text), due_photo_deletions(uuid), mark_photos_deleted(uuid, uuid[], uuid[]),
  create_business(text, text, text, text, text, text, text), my_account() to authenticated;
grant execute on function submit_pickup(uuid, uuid, text, text, text, text, text, text, jsonb), submit_support(text, text, text, text, text),
  search_dobis(text, text, text[], boolean), get_dobi(uuid), pickup_path_ok(text) to anon, authenticated;
grant execute on function pickup_path_member(text), is_platform_admin() to authenticated;

