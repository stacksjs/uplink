import type { AnalyticsConfig } from '@stacksjs/types'

/**
 * **Analytics Configuration**
 *
 * Off, and it always was: nothing on this site injects an analytics script.
 *
 * The scaffold left `driver: 'fathom'` here with a real site id and a Google
 * Analytics placeholder beside it, so anyone who read the config found a
 * tracker declared while `/privacy` told them the site loads none. Both
 * statements cannot be true, and the page is the one that is (#37).
 *
 * Turning this on means adding the script as well, and saying so on the
 * privacy page in the same commit.
 */
export default {
  enabled: false,
  driver: 'fathom',
  drivers: {},
} satisfies AnalyticsConfig
