import { Action } from '@stacksjs/actions'
import { runHealthProbes } from '@stacksjs/router'
import License from '../../Models/License'

/**
 * GET /api/health - whether this server can answer the Mac app, for uptime
 * monitoring (StatusHQ polls it).
 *
 * The one probe that matters is a read of the licenses table: the license
 * check is the request the Mac app cannot do without (it locks itself after
 * 14 days of failed checks), and it is a read of that table. It reads a row
 * that cannot exist, so it costs one indexed lookup and returns nothing.
 *
 * Public and unauthenticated, so it says only which check failed and how long
 * it took. The reason goes to the server log, never into the response: a
 * database error can name a file path or a table layout.
 */
export default new Action({
  name: 'Health',
  description: 'Whether the license API can read its database',
  method: 'GET',

  async handle() {
    const result = await runHealthProbes([
      { name: 'licenses', run: () => License.where('id', 0).first() },
    ], { timeoutMs: 2000 })

    for (const [name, check] of Object.entries(result.checks)) {
      if (!check.ok)
        console.error(`[health] ${name} failed after ${check.ms}ms: ${check.message}`)
    }

    const checks = Object.fromEntries(Object.entries(result.checks).map(([name, { ok, ms }]) => [name, { ok, ms }]))
    return new Response(JSON.stringify({ status: result.status, checks, timestamp: result.timestamp }), {
      status: result.status === 'healthy' ? 200 : 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  },
})
