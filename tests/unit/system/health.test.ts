import { describe, expect, it } from 'bun:test'
import health from '../../../app/Actions/System/HealthAction'

describe('GET /api/health', () => {
  it('answers with which checks passed and nothing about why one failed', async () => {
    const original = console.error
    console.error = () => {}
    let response: Response
    try {
      response = await (health as unknown as { handle: () => Promise<Response> }).handle()
    }
    finally {
      console.error = original
    }
    const body = await response.json() as { status: string, checks: Record<string, Record<string, unknown>> }
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect([200, 503]).toContain(response.status)
    expect(body.status).toBe(response.status === 200 ? 'healthy' : 'degraded')
    expect(Object.keys(body.checks)).toEqual(['licenses'])
    expect(Object.keys(body.checks.licenses!).sort()).toEqual(['ms', 'ok'])
  })
})
