-- SMART DOBI · UPDATE 6 ONLY. Use this if your database already has updates 1-5 (your existing data is kept).
-- Supabase -> SQL Editor -> New query -> paste ALL -> Run. Safe to run twice.
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
