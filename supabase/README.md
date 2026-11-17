# Reader accounts (Supabase)

Optional reader accounts: favorites, the reader's own tags, reading lists and reading history.
The site's code is `assets/account.js`; the database is `schema.sql`. Nothing shows on the site until the
repository variables below are set.

## One-time setup

1. **Project.** At supabase.com, create a project named `foggypress` in a US East region.
2. **Database.** SQL editor → New query → paste all of `schema.sql` → Run. It can be run again after changes.
3. **Sign-in settings.** Authentication → URL Configuration:
   - Site URL: `https://foggypress.com`
   - Redirect URLs: `https://foggypress.com/**` and `https://files.foggypress.com/**`

   Authentication → Sign In / Providers → Email: on; "Confirm email" on. Leave other providers off.
4. **Email wording.** Authentication → Emails → Templates → Magic Link. Subject `Your Foggy Press sign-in link`, body:

   ```html
   <p>Here is your link to sign in to Foggy Press:</p>
   <p><a href="{{ .ConfirmationURL }}">Sign in to Foggy Press</a></p>
   <p>Or type this code on the sign-in page: <strong>{{ .Token }}</strong></p>
   <p>If you didn't ask for this, you can ignore this email.</p>
   ```

   Use the same body for the "Confirm signup" template, with the subject `Welcome to Foggy Press: your sign-in link`.
5. **Sending email.** Create a Resend account, add the domain `foggypress.com`, and add the DNS records it lists
   in Cloudflare (DNS → Records). Then in Supabase, Authentication → Emails → SMTP Settings: host `smtp.resend.com`,
   port 465, user `resend`, password = a Resend API key, sender `signin@foggypress.com`, name `Foggy Press`.
6. **Bot check.** In Cloudflare, Turnstile → Add widget for `foggypress.com` (mode: Managed). Paste its secret key in
   Supabase, Authentication → Attack Protection → Captcha (provider Turnstile).
7. **Repository variables** (GitHub → foggypress-site → Settings → Secrets and variables → Actions → Variables):
   - `SUPABASE_URL`: Project Settings → API → Project URL
   - `SUPABASE_ANON_KEY`: Project Settings → API → the `anon` `public` key
   - `TURNSTILE_SITE_KEY`: the Turnstile widget's site key

   These are public values (they appear in every page), not secrets. The next build turns sign-in on.

## Ask Foggy Press (optional, after the steps above)

The chat that answers questions about the books. It runs as a Supabase Edge Function (`functions/ask/`) that calls
Claude Haiku through the Claude API; `schema.sql` already has its tables, the daily limit and the monthly cap.

1. **Claude API key.** At platform.claude.com: add a payment method, set a monthly spend limit (Settings → Limits;
   $20 is plenty), then API Keys → Create key.
2. **Supabase token.** At supabase.com: Account (top right) → Access Tokens → Generate new token.
3. **Repository secrets** (GitHub → foggypress-site → Settings → Secrets and variables → Actions → Secrets):
   `ANTHROPIC_API_KEY` and `SUPABASE_ACCESS_TOKEN`. Then Actions → "Deploy Ask Foggy Press" → Run workflow. It puts
   the function on Supabase and gives it the key; it runs again by itself whenever `functions/` changes.
4. **Turn it on:** add the repository variable `ASK_ON` = `1`. The next build shows Ask in the menu, on its own page
   (/ask/), and as "Ask about this book" on every read-online page.

5. **Asking without an account (optional).** Add the repository secret `TURNSTILE_SECRET_KEY`: the secret key of the
   same Turnstile widget as in step 6 above (Cloudflare → Turnstile → the foggypress.com widget → Settings). The next
   "Deploy Ask Foggy Press" run gives it to the function, and from then on anyone can ask after the invisible
   "are you human" check, with their own daily limit (`guest_daily_limit`). Without it, asking needs an account.
   The widget's hostname list must include `foggypress.com` (it covers `files.foggypress.com`, where the read pages are).

**Limits.** Supabase → Table Editor → `ask_config`: `daily_limit` (questions per reader per day, default 20),
`guest_daily_limit` (questions per day from one internet address without an account, default 10; 0 turns guests off),
`guests_daily_cap` (all guests together in 24 hours, default 500, a backstop against bots that get past the check),
`monthly_cap_usd` (the most Ask may spend in a calendar month, default $10; when it is reached Ask pauses until the
1st and search keeps working) and `enabled` (off pauses Ask at once). The admin Chat tab shows questions per day,
spending, where people ask, and every answer someone gave a thumbs up or down (question and answer, never who asked).
It reads them live through the function, which answers only for the GitHub account in `ADMIN_GITHUB_LOGINS`
(function secret, default `wmclemens`).
A question usually costs a fraction of a cent, so the default cap covers a few thousand questions a month.

**Another model.** Supabase → Edge Functions → ask → Secrets: `ASK_MODEL` (a Claude model id) with `ASK_PRICE_IN` and
`ASK_PRICE_OUT` (its dollars per million input and output tokens, so the cap stays right).

## Tests

`tests/fake_supabase.sql` makes a plain PostgreSQL 16 database look enough like Supabase (roles, `auth.users`,
`auth.uid()`) to run `schema.sql`; `tests/isolation.sql` then checks that one reader can't see or change another's
rows, the limits, history off, and that deleting an account leaves nothing behind:

```sh
createdb fp_test
psql -d fp_test -f supabase/tests/fake_supabase.sql -f supabase/schema.sql
psql -d fp_test -f supabase/tests/isolation.sql
psql -d fp_test -f supabase/tests/ask.sql
psql -d fp_test -f supabase/tests/ask_guests.sql
```

The ask function's tests use a built copy of the site (served at `SITE`) and a stand-in for the Claude API:

```sh
python build/build.py --files files --out _site && (cd _site && python -m http.server 8766 &)
deno test --allow-net --allow-env --allow-read supabase/functions/ask/ask_test.ts
```
