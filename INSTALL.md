# Smart Dobi – install and live test

All app files sit at the TOP LEVEL (no folders). Upload them all together.

IMPORTANT: this app does NOT use Vercel "environment variables". Your Supabase address and key live in `config.js` only.

## A. Fresh install (new, empty Supabase project)
1. Supabase → Authentication → Providers → Email → turn OFF "Confirm email" (while testing).
2. Supabase → SQL Editor → New query → paste ALL of `FULL_INSTALL.sql` → Run. Expect "Success".
   (Optional safety: search the file for `CHANGE ME` and put your email between the quotes before running.)
3. Open `config.js` and make sure it holds your project's address and publishable key (already set in this copy).
4. GitHub → New repository → Add file → Upload files → drag in every file except the two `.sql` files and `INSTALL.md` → Commit.
   (Already have the repository? Replace the files instead, with the pencil icon.)
5. Vercel → import the repository → Framework: Other → leave build and output empty → Deploy.
6. Supabase → Authentication → URL Configuration → set Site URL to your Vercel address.
7. Open your site. If anything says it cannot connect, open `your-site/status`. It tells you exactly what is wrong.
8. Shop sign-in → Create account with YOUR email. The first account becomes the SUPER ADMIN and lands on /admin.

## B. Update (you already have updates 1–5 and real data)
1. Supabase → SQL Editor → paste `UPDATE_6_ONLY.sql` → Run. (Your data is kept.)
2. GitHub: replace config.js, vercel.json, api.js, util.js, core.js, public.js, shop.js, money.js, admin.js, app.js, sw.js, styles.css and add upgrade.js.

## C. Set up the platform (super admin)
- Payments → "Payment details shops see": enter your MTN and Airtel codes and names → Save.
- Plans: Free plan (price 0) is the default for new shops. Edit prices, limits, features and photo-clearing hours per plan.
- Team: add view-only support staff by email.

## D. Live test script (use a private window for each person)
1. SHOP: sign up with a second email → set up → starts on the Free plan. ☰ → Public Dobi profile (admin PIN) → area, services → tick "Show this shop in the directory" → Save.
2. CUSTOMER (no login): search your shop → open it → add items (try a photo) → give a WhatsApp number or email → "Pick up my items".
3. SHOP: Requests → Review & price → set prices → Process invoice → share. The order shows in Orders as "Pickup order".
4. SHOP: Orders → open the order → statuses → Hand-over: Accepted / Not accepted / owner clear.
5. SHOP: Receive Clothes for a walk-in; share the tracking link.
6. SHOP (paid plan): ☰ → Prices, invoices & receipts, Expenses, Reports; try airplane mode then Sync now.
7. SUPER ADMIN: Subscriptions → "Switch off plan". SHOP: sign in → "Restricted: your plan has expired. Upgrade to continue."
8. SHOP: choose a plan → see MTN/Airtel codes → submit number, transaction ID, screenshot. SUPER ADMIN: Payments → View proof → Approve or Reject with a reason.
9. Anyone: footer or ☰ → Support / Partner with us. SUPER ADMIN: Messages. Then Activity.

## Good to know
- Photo clearing: each plan sets the hours after an order closes when its photos are deleted. It runs when someone from that shop uses the app online (at most hourly). Orders, payments and sales are kept.
- Receiving clothes, photos and status changes need internet. Money entries, receipts and reports work offline and sync later.
- Upgrade payments are checked by you by hand. Nothing is verified automatically with MTN or Airtel.
- WhatsApp, email and SMS open on the sender's own phone. Smart Dobi cannot confirm delivery.
- PINs are a convenience lock, not strong security.
