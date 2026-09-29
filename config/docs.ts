import type { BunPressOptions } from '@stacksjs/bunpress'
import { env } from '@stacksjs/env'

/**
 * **Documentation Configuration**
 *
 * Your app's documentation site, built with BunPress from `docs/`, served at
 * /docs by `buddy dev`.
 *
 * Every page below has to exist in `docs/`, because nothing checks that a nav
 * or sidebar link resolves.
 */

// APP_URL is often a bare host, which is not a URL on its own.
const appUrl = String(env.APP_URL || '').replace(/\/+$/, '')
const siteUrl = appUrl && !/^https?:\/\//.test(appUrl) ? `https://${appUrl}` : appUrl

const config: BunPressOptions = {
  verbose: false,
  docsDir: './docs',
  outDir: './dist/docs',

  nav: [
    { text: 'Install', link: '/install' },
    { text: 'Configuration', link: '/configuration' },
    { text: 'Security', link: '/security' },
    { text: 'GitHub', link: 'https://github.com/stacksjs/uplink' },
  ],

  markdown: {
    title: `${env.APP_NAME || 'Uplink'} Documentation`,
    meta: {
      description: '',
      author: env.APP_NAME || 'Uplink',
    },
    syntaxHighlightTheme: 'github-dark',
    toc: {
      enabled: true,
      minDepth: 2,
      maxDepth: 3,
    },
    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/' },
            { text: 'Install', link: '/install' },
            { text: 'Permissions', link: '/permissions' },
          ],
        },
        {
          text: 'Running it',
          items: [
            { text: 'Configuration', link: '/configuration' },
            { text: 'Security', link: '/security' },
          ],
        },
        {
          text: 'When it goes wrong',
          items: [
            { text: 'Troubleshooting', link: '/troubleshooting' },
            { text: 'Uninstall', link: '/uninstall' },
          ],
        },
      ],
    },
  },

  sitemap: {
    enabled: Boolean(siteUrl),
    baseUrl: siteUrl ? `${siteUrl}/docs` : '',
  },

  robots: {
    enabled: true,
  },
}

export default config
