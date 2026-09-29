import type { EmailConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

export default {
  from: {
    name: env.MAIL_FROM_NAME || 'Uplink',
    address: env.MAIL_FROM_ADDRESS || 'hello@example.com',
  },

  // Uplink sends from uplink@stacksjs.com, a mailbox on the stacks box's mail
  // server (`buddy mail:provision` creates it from MAIL_PASSWORD_UPLINK). The
  // stacksjs.com domain already carries the SPF, DKIM and DMARC records.
  domain: env.MAIL_DOMAIN || env.APP_DOMAIN || 'example.com',
  mailboxes: ['uplink'],
  forwards: {},
  url: env.APP_URL || 'uplink.localhost',
  charset: 'UTF-8',

  server: {
    // Explicit opt-in: a generated application must never reconcile the
    // framework repository's shared mail server or mailboxes.
    enabled: false,
    scan: true,
    subdomain: 'mail',
  },
} satisfies EmailConfig
