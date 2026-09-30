import type { AppConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Application Configuration**
 *
 * This configuration defines all of your application options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  name: env.APP_NAME ?? 'Uplink',
  // Shown on the starter page, the coming-soon page, and any page that sets
  // no description of its own.
  description: '',
  env: env.APP_ENV ?? 'local',
  url: env.APP_URL ?? 'stacks.localhost',
  redirectUrls: [],
  debug: env.DEBUG ?? false,
  key: env.APP_KEY,

  maintenanceMode: env.APP_MAINTENANCE ?? false,
  comingSoonMode: env.APP_COMING_SOON ?? false,
  comingSoonSecret: env.APP_COMING_SOON_SECRET ?? '',
  // docMode: true, // instead of example.com/docs, deploys example.com as main entry point for docs
  docMode: false,

  timezone: 'America/Los_Angeles',
  locale: 'en',
  fallbackLocale: 'en',
  cipher: 'aes-256-cbc',

  // /sitemap.xml and /robots.txt are generated from resources/views. Pages
  // that set `noindex` (thanks, checkout, license) stay out of the sitemap on
  // their own; robots only has to keep crawlers off /checkout/, where every
  // request opens a Stripe Checkout session. /api/ is disallowed by default.
  seo: {
    origin: 'https://uplink.stacksjs.com',
    robots: { disallow: ['/checkout/', '/thanks'] },
  },
} satisfies AppConfig
