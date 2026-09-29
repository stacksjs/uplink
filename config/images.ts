import type { ImagesConfig } from '@stacksjs/types'

/**
 * Generated imagery for Uplink, built by `buddy generate:images`.
 *
 * One source for the brand: the app icon the Mac bundle ships
 * (resources/assets/images/app-icon.png, which the DMG build reads too).
 * The favicons, the web manifest and the link-preview cards are all derived
 * from it, so a new icon is one file and one command.
 *
 * The cards use the site's palette: near-black with the sodium-amber accent
 * of the city lights in the hero photo, set in Geist like the pages.
 */
export default {
  brand: 'Uplink',
  mark: 'resources/assets/images/app-icon.png',
  // The icon is already a plate: drawing another one behind it boxes it twice.
  markPlate: false,

  fonts: {
    title: 'resources/assets/fonts/geist/Geist-Bold.ttf',
    body: 'resources/assets/fonts/geist/Geist-Regular.ttf',
  },

  background: {
    color: '#0c0c0e',
    gradient: { angle: 160, stops: [
      { offset: 0, color: '#141417' },
      { offset: 1, color: '#0c0c0e' },
    ] },
    glows: [{ x: 0.86, y: 0.1, radius: 0.62, color: '#f59e0b2e' }],
  },
  color: '#f4f4f5',
  mutedColor: '#a1a1aa',
  accent: '#f59e0b',

  social: {
    enabled: true,
    outputDir: 'public/social',
    publicPath: '/social',
    // The one 1200x630 card every consumer reads. Square and portrait crops
    // only earn their place when something links them directly.
    presets: ['og'],
    format: 'png',
    pages: [
      {
        path: '/',
        eyebrow: 'For Mac',
        title: 'Text your Mac. Claude answers, even over satellite.',
        subtitle: 'An iMessage with no signal becomes a Claude Code run on your Mac, and the reply comes back as a text.',
      },
      {
        path: '/pricing',
        eyebrow: 'Pricing',
        title: '$1.99 a month, $19.99 a year, or $29.99 once.',
        subtitle: 'Every plan is the whole app, running on your own Claude or ChatGPT plan.',
      },
    ],
  },

  appStore: {
    enabled: false,
  },

  appIcons: {
    enabled: true,
    source: 'resources/assets/images/app-icon.png',
    outputDir: 'resources/app-icons',
    // A web set only: the Mac bundle's icon comes from the source file itself.
    platforms: [],
    favicon: true,
    faviconDir: 'public',
    manifest: {
      name: 'Uplink',
      shortName: 'Uplink',
      themeColor: '#0c0c0e',
      backgroundColor: '#0c0c0e',
    },
  },
} satisfies ImagesConfig
