# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`kaede-photo` is the static marketing/booking site for a family photographer (out-call newborn/maternity/shichigosan/birthday photography, Osaka/Kansai area). It's a static HTML site (`public/`) plus a single Netlify Function that handles the booking form submission. No frontend framework, no bundler, no build step.

The git repo root is this `kaede-photo/` directory (the parent folder `kaede photo/` is not part of the repo).

## Commands

```bash
npm run dev     # netlify dev — serves public/ + functions together, closest to production
npm run build   # no-op ("No build step (static site)")
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
  birthday-collab.html, birthday-kyoto.html
                              Time-limited collaboration campaign landing pages
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
```

### Booking flow (`netlify/functions/booking.js`)

This is the only piece of backend logic in the project, and it's dense — read the file's own comments before changing it, they explain a lot of non-obvious decisions. Key things to know:

- **Pricing is recomputed server-side, never trusted from the client.** `computeEstimate()` in `booking.js` maintains `OPTION_PRICES` and `AREA_PRICES` tables independently of what the form displayed. If you add a new paid option or change a price in `index.html`'s form, you **must** update the matching table in `booking.js` — the stable keys (`data-opt`, `data-area` attributes in the HTML) are what tie the two together, not the display labels.
- **Genre/plan values are validated against whitelists** (`ALLOWED_GENRES`, `ALLOWED_PLANS`) matched against stable keys (e.g. `newborn`, not `ニューボーン`). The `GENRE_LIST` in `index.html` and `ALLOWED_GENRES`/`GENRE_LABELS` in `booking.js` must stay in sync.
- **Origin checking** (`isAllowedOrigin`) is CSRF protection, not spam protection — it only allows `kaede-photo.com` + this project's own Netlify URLs, deliberately not `*.netlify.app` broadly.
- **Rate limiting** (Upstash Redis) is optional infra — the function still works without it, but logs a warning and runs fully open. Two limits: per-IP (5/hour) and site-wide (40/day, to protect the sending domain's reputation), each independently.
- **Mail is sent serially, not in parallel**: owner notification first, then customer auto-reply only if that succeeds — so a failure never results in the customer thinking they're booked while the owner never got notified.
- **Notion recording is best-effort** and happens last; a Notion failure doesn't fail the booking, it emails the owner an alert instead. Optional Notion properties (`撮影ジャンル`, `エリア`, `概算金額`) are only sent if they already exist on the target database (checked via a 10-minute-TTL cache), so an unconfigured database doesn't break bookings.

### Landing page pattern

Genre pages (`newborn.html`, `maternity.html`, `omiyamairi.html`, `shichigosan.html`, `birthday.html`) and the area SEO pages are structurally near-identical (~1030–480 lines each): hero, shared nav/footer markup, FAQ accordion, all wired up by the shared `lp-common.js`. When editing shared behavior (nav, menu, FAQ, GA4 click tracking), edit `lp-common.js` once rather than per-page. When editing shared visual language (colors, fonts), prefer `tokens.css` custom properties over hardcoded values.

`area-*.html` pages are currently `noindex,nofollow` (see `<meta name="robots">` in each) — they were accidentally published before content was sufficiently differentiated per-prefecture; don't remove the noindex tag without checking whether that's intentional.

## Environment / secrets

Never read or print `.env` — required vars are documented (without values) in `.env.example` and `SETUP.md`. The function needs: `RESEND_API_KEY`, `MAIL_FROM`, `OWNER_EMAIL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `SITE_URL`.

## Deployment

Netlify auto-deploys `main`. There is no staging environment — changes pushed to `main` go live. `netlify.toml` also defines the CSP and other security headers; if you add a new external script/resource, it needs a matching `connect-src`/`script-src`/etc. entry there or it will be silently blocked in production.
