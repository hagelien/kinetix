# Kinetix Rename Checklist

Manual follow-up outside the repo:

- Rename the Vercel project from `fjelltox` to `kinetix`, then confirm preview aliases switch away from `fjelltox-*`.
- Keep `kinetix.no` and `www.kinetix.no` as the primary domains. Leave old `fjelltox` hostnames attached only long enough to issue redirects.
- Update Vercel env vars and secrets that still reference the old name, especially `PUBLIC_APP_URL`, `RESEND_FROM_EMAIL`, and any contact email values.
- Rename the GitHub repository from `hagelien/fjelltox` to `hagelien/kinetix`, then update local remotes and reconnect any external integrations if needed.
- Verify the active Neon project, database, and branch naming. If production still uses a literal `fjelltox` database, provision `kinetix`, migrate data, switch connection strings, validate, then retire the old one.
- Update Resend sender branding and domain verification so email is sent from `Kinetix <noreply@kinetix.no>` or the chosen Kinetix sender.
- Keep DNS and TLS valid for both old and new domains during the redirect window.
- Recheck third-party API contact identity after deploy so Crossref, Wikidata, and enrichment traffic all advertise `Kinetix` and `kinetix.no`.
