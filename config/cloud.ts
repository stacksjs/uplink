import type { CloudConfig } from '@stacksjs/types'
import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import { env } from '@stacksjs/env'

const APP_SLUG = 'uplink'
const APP_DOMAIN = env.APP_DOMAIN || 'uplink.stacksjs.com'

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
              bypassPaths: ['/api/', '/_stacks/'],
            },
            purgeOnDeploy: true,
          },
        },
      },
    },
  },

  sites: {
    main: {
      root: '.',
      path: '/',
      domain: APP_DOMAIN,
      start: 'bun node_modules/@stacksjs/buddy/dist/serve-entry.js',
      port: 3240,
      // The compiled Uplink.app, its heartbeat and the chat.db cursor are
      // this Mac's, not the site's (and the .app alone is 60 MB).
      exclude: ['storage/uplink'],
      preStart: ['bun install --frozen-lockfile'],
      env: {
        HOST: '127.0.0.1',
        APP_ENV: 'production',
        NODE_ENV: 'production',
        APP_NAME: 'Uplink',
        APP_URL: APP_DOMAIN,
        APP_KEY: env.APP_KEY || '',
        PORT_API: '3248',
        API_URL: 'http://127.0.0.1:3248',
        STACKS_DEFAULT_ROUTES: 'none',
        DB_CONNECTION: 'sqlite',
        DB_DATABASE: '/var/lib/uplink/stacks.sqlite',
        DB_DATABASE_PATH: '/var/lib/uplink/stacks.sqlite',
      },
    },
  },
}

const config: CloudConfig = {}

export default config
