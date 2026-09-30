import { response, route } from '@stacksjs/router'

/**
 * This file is the entry point for your application's API routes.
 * The routes defined here are automatically registered. Last but
 * not least, you may also create any other `routes/*.ts` files.
 *
 * Every route in this file is mounted under `/api`. The prefix comes from
 * the `'api'` key in `app/Routes.ts` and lines up with the path the dev
 * proxy forwards (`/api/*`), so `route.get('/hello', ...)` below answers
 * `GET /api/hello`. Paths at the document root belong in a route file
 * whose registry entry sets `prefix: ''`.
 *
 * Framework routes (auth, dashboard, commerce, CMS, etc.) are loaded
 * automatically from storage/framework/defaults/routes/dashboard.ts.
 * You do NOT need to define them here — only add your own custom routes.
 *
 * @see https://docs.stacksjs.com/routing
 */

// Your custom routes go here. This one answers `GET /api/hello`:
route.get('/hello', () => response.text('hello world'))

// Uptime monitoring's view of the license API: can it read its database.
// StatusHQ polls this alongside a real license check (see the action).
route.get('/health', 'Actions/System/HealthAction')

// The Mac app's license check and its way into the Stripe customer portal.
// Both take the license key, which is the only credential the app holds. No
// cookie is involved - the caller is a native app, not a browser session - so
// there is nothing for a CSRF token to protect, and the app has none to send.
route.post('/license/check', 'Actions/License/CheckLicenseAction').skipCsrf()
route.post('/billing/portal', 'Actions/Billing/OpenPortalAction').skipCsrf()
// Stripe's own copy of a completed checkout. It carries a signature rather
// than a session cookie, so it skips CSRF like the two above, and it is the
// reason a buyer who never loads /thanks still gets a key.
route.post('/billing/webhook', 'Actions/Billing/StripeWebhookAction').skipCsrf()
// The /license page's "email me my key" form. Unlike the three above, a
// browser posts it, so it keeps the CSRF check: the form carries the token the
// page was rendered with. Its rate limits (per IP and per address) live in the
// action rather than on the route, so the form can be told it hit one instead
// of landing on a bare 429.
route.post('/license/resend', 'Actions/License/ResendLicenseAction')

// `/coming-soon` is served as an STX view from
// `storage/framework/defaults/resources/views/coming-soon.stx`. The
// view auto-resolves through stx-serve, so no route registration is
// needed here. To activate the holding page across the whole app:
//
//   ./buddy coming-soon [--secret=my-magic-token]
//
// Launch the site with `./buddy launch`. Maintenance mode (503 page,
// distinct cookie + state file) is the separate `./buddy down` /
// `./buddy up` pair.
