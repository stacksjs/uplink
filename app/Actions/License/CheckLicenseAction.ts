import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { licenses } from '../../Billing/license-store'

/**
 * POST /api/license/check { key } - where a license stands, for the Mac app.
 * The app gates answering texts on `valid`, and keeps the answer so it still
 * works for a while with no connection (the point is being off-grid).
 */
export default new Action({
  name: 'Check License',
  description: 'Whether an Uplink license key is paid up',
  method: 'POST',

  async handle(request: RequestInstance) {
    const standing = await (await licenses()).check(request.get('key'))
    if (!standing)
      return response.json({ valid: false, error: 'That license key is not one Uplink issued.' }, 404)
    return response.json(standing)
  },
})
