import type { CloudConfig } from '@stacksjs/types'
import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import { env } from '@stacksjs/env'

const APP_SLUG = 'uplink'
const APP_DOMAIN = env.APP_DOMAIN || 'uplink.stacksjs.com'
const PORT_MAIN = 3240
const PORT_API = 3248

/**
 * State that must outlive a release: the SQLite file holding licenses.
 *
 * Deploys are atomic, so anything written inside a release is gone at the
 * next one; the database lives outside the release tree and is symlinked in.
 * The FILE is shared, not `database/`: sharing the directory would replace the
 * release's migrations too, and `migrate` would find nothing to run (the trap
 * campushq documents).
 */
const STATE_DIR = '/var/lib/uplink'

function sharedState(seed: boolean) {
  return [{ path: 'database/stacks.sqlite', target: `${STATE_DIR}/stacks.sqlite`, seed }]
}

/** What both processes run with. */
const SHARED_ENV = {
  HOST: '127.0.0.1',
  APP_ENV: 'production',
  NODE_ENV: 'production',
  APP_NAME: 'Uplink',
  APP_URL: APP_DOMAIN,
  APP_KEY: env.APP_KEY || '',
  STACKS_DEFAULT_ROUTES: 'none',
  DB_CONNECTION: 'sqlite',
}

/**
 * uplink.stacksjs.com: the public page, a tenant on the stacks Hetzner box.
 *
 * Only the marketing page is public. The Uplink service itself runs on the
 * Mac that holds Messages; nothing here reads a chat.db or runs an agent, and
 * `/dashboard` answers 404 in production. So the release mounts no framework
 * routes (`STACKS_DEFAULT_ROUTES: 'none'`) and runs no migrations.
 *
 * Ports 3240/3248 were free in `ss -lntp` on the box on 2026-09-27 (config
 * files are not a reliable source: two tenants can bind one port silently).
 */
export const tsCloud: TsCloudConfig = {
  project: {
    name: APP_SLUG,
    slug: APP_SLUG,
    region: 'us-east-1',
  },

  stateDir: 'storage/cloud',

  cloud: {
    provider: 'hetzner',
    attachTo: 'stacks',
  },

  mode: 'server',

  environments: {
    production: {
      type: 'production',
      deployBranch: 'main',
      region: 'us-east-1',
      variables: {
        APP_ENV: 'production',
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
    },
  },

  infrastructure: {
    dns: {
      provider: 'cloudflare',
      domain: 'stacksjs.com',
    },

    compute: {
      instances: 1,
      size: 'small',
      disk: {
        size: 20,
        type: 'ssd',
        encrypted: true,
      },
      webServer: 'rpx',
      proxy: {
        engine: 'rpx',
        onDemandTls: true,

        cdn: {
          provider: 'cloudflare',
          frontedHosts: [APP_DOMAIN],
          cloudflare: {
            settings: {
              ssl: 'strict',
              alwaysUseHttps: true,
              minTlsVersion: '1.2',
              brotli: true,
              http3: true,
              emailObfuscation: false,
            },
            cache: {
              assetEdgeTtl: 2592000,
              documentEdgeTtl: 300,
              // Pages that are about one visitor. Cloudflare's document rule
              // overrides the origin's no-store, and when it stores a page it
              // drops the Set-Cookie: /license then served every visitor the
              // same cached CSRF token and no cookie to match it, so its form
              // could only ever answer 403. /thanks shows one buyer's key and
              // must not show a pre-payment copy for five minutes; /checkout/
              // opens a Stripe session per request.
              bypassPaths: ['/api/', '/_stacks/', '/license', '/thanks', '/checkout/'],
            },
            purgeOnDeploy: true,
          },
        },
      },
    },
  },

  sites: {
    /**
     * The public site: pages, pricing, checkout and the thank-you page that
     * issues licenses. It runs the migrations, because it is the one that may
     * seed the shared database file.
     */
    main: {
      root: '.',
      path: '/',
      domain: APP_DOMAIN,
      start: 'bun node_modules/@stacksjs/buddy/dist/serve-entry.js',
      port: PORT_MAIN,
      // The compiled Uplink.app, its heartbeat and the chat.db cursor are
      // this Mac's, not the site's (and the .app alone is 60 MB).
      exclude: ['storage/uplink'],
      sharedPaths: sharedState(true),
      preStart: [
        'echo "[uplink] preStart: install"',
        'bun install --frozen-lockfile',
        'echo "[uplink] preStart: migrate"',
        'bun node_modules/@stacksjs/buddy/dist/cli.js migrate',
        'echo "[uplink] preStart: done"',
      ],
      env: {
        ...SHARED_ENV,
        PORT_API: String(PORT_API),
        API_URL: `http://127.0.0.1:${PORT_API}`,
      },
    },

    /**
     * The API: the Mac app's license check and its link into the Stripe
     * customer portal (routes/api.ts). The main site proxies /api/** here.
     */
    api: {
      root: '.',
      start: 'bun node_modules/@stacksjs/actions/dist/serve/api.js',
      port: PORT_API,
      exclude: ['storage/uplink'],
      // The same database file as main, and never the one that seeds it.
      sharedPaths: sharedState(false),
      preStart: ['bun install --frozen-lockfile'],
      env: {
        ...SHARED_ENV,
        PORT_API: String(PORT_API),
      },
    },
  },
}

const config: CloudConfig = {}

export default config
