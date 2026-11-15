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

## Tests

`tests/fake_supabase.sql` makes a plain PostgreSQL 16 database look enough like Supabase (roles, `auth.users`,
`auth.uid()`) to run `schema.sql`; `tests/isolation.sql` then checks that one reader can't see or change another's
rows, the limits, history off, and that deleting an account leaves nothing behind:

```sh
createdb fp_test
psql -d fp_test -f supabase/tests/fake_supabase.sql -f supabase/schema.sql
psql -d fp_test -f supabase/tests/isolation.sql
```
