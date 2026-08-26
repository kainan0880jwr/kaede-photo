# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`kaede-photo` is the static marketing/booking site for a family photographer (out-call newborn/maternity/shichigosan/birthday photography, Osaka/Kansai area). It's a static HTML site (`public/`) plus a single Netlify Function that handles the booking form submission. No frontend framework, no bundler, no build step.

The git repo root is this `kaede-photo/` directory (the parent folder `kaede photo/` is not part of the repo).

## Commands

```bash
npm run dev           # netlify dev — serves public/ + functions together, closest to production
npm run build         # no-op ("No build step (static site)")
npm run check:prices  # diff index.html's displayed prices against booking.js's price tables (run after any pricing edit)
```

There is also a plain-static-only launch config at `.claude/launch.json` (`python3 -m http.server 8770 --directory public`) for when you just need to preview HTML/CSS without the booking API working.

No test suite, linter, or type checker is configured — verify changes by running `netlify dev` and exercising the page/form in a browser.

## Architecture

```
public/                     Static site, deployed as-is (Netlify `publish = "public"`)
  index.html                 Home page + the booking form (long — pricing, options, form logic all inline)
  newborn.html, maternity.html, omiyamairi.html, shichigosan.html, birthday.html
                              Genre landing pages, structurally identical, share lp-common.js
  area-*.html                 Prefecture SEO landing pages — currently noindex,nofollow (see below)
  birthday-collab.html        Time-limited collaboration campaign landing page (live)
  birthday-kyoto.html          Draft campaign page for a future event — intentionally NOT committed
                               (untracked in git; see docs/birthday-kyoto.README.txt before touching it)
  photographer.html           Photographer bio page
  lp-common.js                Shared JS for landing pages: sticky nav, hamburger menu, FAQ accordion, GA4 click tracking
  tokens.css                  Design tokens (CSS custom properties: colors, fonts, easing) shared across pages
  sitemap.xml / robots.txt

netlify/functions/
  booking.js                  The one API endpoint (`POST /api/booking`, routed via netlify.toml redirect).
                               Handles CORS/origin check → rate limit → validation → email → Notion, in that order.
  utils/email-templates.js    HTML email bodies (owner notification, customer auto-reply, failure alerts)
  utils/notion.js              Writes the booking to a Notion database (best-effort — failures alert the owner but don't fail the request)

netlify.toml                  Security headers (CSP etc.), the /api/booking redirect, and 301s for extensionless URLs
docs/                          Standalone notes for specific pages (currently just birthday-kyoto's reuse instructions)
```

### Booking flow (`netlify/functions/booking.js`)

This is the only piece of backend logic in the project, and it's dense — read the file's own comments before changing it, they explain a lot of non-obvious decisions. Key things to know:

- **Pricing is recomputed server-side, never trusted from the client.** `computeEstimate()` in `booking.js` maintains `OPTION_PRICES` and `AREA_PRICES` tables independently of what the form displayed. If you add a new paid option or change a price in `index.html`'s form, you **must** update the matching table in `booking.js` — the stable keys (`data-opt`, `data-area` attributes in the HTML) are what tie the two together, not the display labels. Run `npm run check:prices` after any price/plan edit — it statically diffs `index.html`'s displayed prices against `booking.js`'s `OPTION_PRICES`/`AREA_PRICES`/`ALLOWED_PLANS` and fails if they've drifted (there's no CI, so this is a manual pre-deploy step, not automatic).
- **Genre/plan values are validated against whitelists** (`ALLOWED_GENRES`, `ALLOWED_PLANS`) matched against stable keys (e.g. `newborn`, not `ニューボーン`). The `GENRE_LIST` in `index.html` and `ALLOWED_GENRES`/`GENRE_LABELS` in `booking.js` must stay in sync. `ALLOWED_PLANS` matching ignores a trailing `（...）` annotation (`normalizePlanForMatch`), so cosmetic badge text like `（おすすめ）` can change without breaking bookings — but the price-bearing prefix (e.g. `standard ¥29,000`) must still match exactly.
- **Time-limited campaign plans need an explicit deadline.** `SMASH_CAKE_PLANS`/`SMASH_CAKE_PLAN_DEADLINE` in `booking.js` reject the mémoire×kaede photo collab plans after the event date, even though the plan strings remain in `ALLOWED_PLANS` — otherwise anyone who finds the old plan string (page source, web archive) could book the expired campaign price indefinitely. Any future time-limited plan needs the same treatment.
- **The referral discount (`referral`) applies to a future booking, not the current one.** `OPTION_PRICES.referral` is `0` on purpose — the checkbox/UI text says the ¥3,000 discount is for each side's *next* booking, so it must not reduce today's estimate. The discount itself is tracked via the referrer's name (typed into the form) and redeemed manually by the photographer at that future booking; there's no automated redemption.
- **Origin checking** (`isAllowedOrigin`) is CSRF protection, not spam protection — it only allows `kaede-photo.com` + this project's own Netlify URLs, deliberately not `*.netlify.app` broadly.
- **Rate limiting** (Upstash Redis) is optional infra — the function still works without it, but logs a warning and runs fully open. Two limits: per-IP (5/hour) and site-wide (40/day, to protect the sending domain's reputation), each independently.
- **Mail is sent serially, not in parallel**: owner notification first, then customer auto-reply only if that succeeds — so a failure never results in the customer thinking they're booked while the owner never got notified.
- **Notion recording is best-effort** and happens last; a Notion failure doesn't fail the booking, it emails the owner an alert instead. Optional Notion properties (`撮影ジャンル`, `エリア`, `概算金額`, `プライバシー同意`, `掲載同意`, `掲載同意の範囲`) are only sent if they already exist on the target database (checked via a 10-minute-TTL cache), so an unconfigured database doesn't break bookings. The consent properties are checkboxes/rich text you must create manually in Notion for them to actually be recorded (same opt-in pattern as `ステータス`).
- **Consent is validated server-side, not just in the HTML form.** `privacyConsent` (boolean) is required by `validate()` — a request without it is rejected, closing the gap where hitting `/api/booking` directly could skip the privacy-policy checkbox entirely. Portrait/SNS-publication consent (`sns_face`/`sns_noface` on the main form, `collab_sns` on `birthday-collab.html`) is derived server-side from `optionKeys` via `deriveSnsConsent()` — trustworthy because those keys are already whitelist-checked — and recorded as `data.snsConsent`/`data.snsConsentScope`, independent of the ¥0/¥-1000/¥-500 pricing effect of the same keys.

### Landing page pattern

Genre pages (`newborn.html`, `maternity.html`, `omiyamairi.html`, `shichigosan.html`, `birthday.html`) and the area SEO pages are structurally near-identical (~1030–480 lines each): hero, shared nav/footer markup, FAQ accordion, all wired up by the shared `lp-common.js`. When editing shared behavior (nav, menu, FAQ, GA4 click tracking), edit `lp-common.js` once rather than per-page. When editing shared visual language (colors, fonts), prefer `tokens.css` custom properties over hardcoded values.

`area-*.html` pages are currently `noindex,nofollow` (see `<meta name="robots">` in each) — they were accidentally published before content was sufficiently differentiated per-prefecture; don't remove the noindex tag without checking whether that's intentional.

`birthday-kyoto.html` is a paused draft (its event sold out before launch) kept locally and deliberately untracked — do not `git add`/commit it. `docs/birthday-kyoto.README.txt` documents what needs updating to reuse it for a future event, including the two steps required before it can ever go live: adding its plan strings to `booking.js`'s `ALLOWED_PLANS` and adding its extensionless-URL redirect to `netlify.toml` (both currently absent on purpose).

### Cancellation policy duplication (manual sync, no tooling)

The cancellation/refund policy (studio fees, deposit terms, 特商法12条の6 confirmation-screen text) is written out independently in at least `index.html` (`#policy`, `#tokusho`, and the booking-form deposit note) and `birthday-collab.html` (deposit note + confirm-dialog text). There is a comment at the `birthday-collab.html` confirm dialog reminding editors to update `index.html` too, but nothing enforces it — unlike pricing, there's no `check:prices`-style script for policy text. When editing cancellation/refund wording, grep for `原則返金されません` and `キャンセル` across `public/*.html` and update every match, not just the one you started in.

## Environment / secrets

Never read or print `.env` — required vars are documented (without values) in `.env.example` and `SETUP.md`. The function needs: `RESEND_API_KEY`, `MAIL_FROM`, `OWNER_EMAIL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `SITE_URL`.

## Deployment

Netlify auto-deploys `main`. There is no staging environment — changes pushed to `main` go live. `netlify.toml` also defines the CSP and other security headers; if you add a new external script/resource, it needs a matching `connect-src`/`script-src`/etc. entry there or it will be silently blocked in production.
