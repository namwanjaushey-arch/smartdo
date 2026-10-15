# Smart Dobi – install and live test

All app files sit at the TOP LEVEL (no folders). Upload them all together.

## A. Fresh install (new, empty Supabase project)
1. Supabase → Authentication → Providers → Email → turn OFF "Confirm email" (while testing).
2. Supabase → SQL Editor → New query → paste ALL of `FULL_INSTALL.sql` → Run. Expect "Success".
   (Optional safety: before running, search the file for `CHANGE ME` and put your email between the quotes.)
3. GitHub → New repository (private) → Add file → Upload files → drag in every file except the two `.sql` files and `INSTALL.md` → Commit.
4. Vercel → Add New → Project → import the repository → Framework: Other → leave build and output empty → Deploy.
5. Supabase → Authentication → URL Configuration → set Site URL to your Vercel address.
6. Open your site → Shop sign-in → Create account with YOUR email. The first account becomes the SUPER ADMIN and lands on /admin.

## B. Update (you already have updates 1–5 and real data)
1. Supabase → SQL Editor → paste `UPDATE_6_ONLY.sql` → Run. (Your data is kept.)
2. GitHub: replace these files (pencil icon): api.js, util.js, core.js, public.js, shop.js, money.js, admin.js, app.js, sw.js, styles.css. Add the NEW file upgrade.js. Everything else stays.

## C. Set up the platform (super admin)
- Payments → "Payment details shops see": enter your MTN and Airtel codes and account names → Save.
- Plans: the Free plan (price 0) is the default for new shops. Edit prices, limits, features and "Delete order photos … hours after an order is closed" for each plan. Change the default plan with the selector at the top.
- Team: add support staff (view-only) by email (they must already have an account).

## D. Live test script (use a private window for each person)
1. SHOP: sign up with a second email → set up the shop → it starts on the Free plan. Open ☰ → Public Dobi profile (admin PIN) → choose area and services → tick "Show this shop in the directory" → Save.
2. CUSTOMER (no login): open the site → search your shop → open it → add items (try a photo) → give a WhatsApp number or email → "Pick up my items".
3. SHOP: Requests → Review & price → set prices → Process invoice → share it (WhatsApp / email / SMS). The order appears in Orders labelled "Pickup order".
4. SHOP: Orders → open the order → change statuses → Hand-over: tick items → Accepted / Not accepted (reason) / owner clear.
5. SHOP: Receive Clothes for a walk-in customer; share the tracking link; open it as the customer.
6. SHOP: money (needs a paid plan): ☰ → Prices, invoices & receipts, Expenses, Reports; try offline (airplane mode) then Sync now.
7. SUPER ADMIN: Subscriptions → "Switch off plan" for the test shop. SHOP: sign in again → sees "Restricted: your plan has expired. Upgrade to continue."
8. SHOP: choose a plan → see your MTN/Airtel codes → submit number, transaction ID and a screenshot. SUPER ADMIN: Payments → view proof → Approve (or Reject with a reason). SHOP: access returns and the plan changes.
9. Anyone: ☰ or the page footer → Support / Partner with us → send. SUPER ADMIN: Messages.
10. SUPER ADMIN: Activity shows which shops and people are active.

## Good to know
- Photo clearing: each plan sets how many hours after an order is closed its photos are deleted. The deletion runs when someone from that shop uses the app online (at most once an hour). Orders, payments and sales are kept; only photos go.
- Receiving clothes, photos and status changes need internet. Money entries, receipts and reports work offline and sync later.
- Upgrade payments are checked by you by hand (proof + transaction ID). Nothing is verified automatically with MTN or Airtel.
- WhatsApp, email and SMS open on the sender's own phone. Smart Dobi cannot confirm delivery.
- Customer photos for pickup requests: only JPEG, up to 1 MB, only for listed shops.
- PINs are a convenience lock, not strong security.
