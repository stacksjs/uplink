import type { Check, Heartbeat } from './doctor'
import { homedir } from 'node:os'
import process from 'node:process'
import Run from '../Models/Run'
import { loadConfig } from './config'
import { readHeartbeat, runChecks } from './doctor'
import { formatDuration, truncate } from './format'

/**
 * Everything the dashboard page shows, gathered in one call: a view gets one
 * top-level await (a second one silently empties the whole script scope).
 */

export interface RunRow {
  id: number
  prompt: string
  where: string
  status: string
  answer: string
  when: string
  took: string
  cost: string
}

export interface DashboardData {
  live: boolean
  headline: string
  checks: Check[]
  ready: boolean
  allowed: string[]
  active: Array<{ prompt: string, elapsed: string, lastActivity: string }>
  runs: RunRow[]
  totals: { runs: number, done: number, failed: number, spend: string }
}

function tildify(path: string | null): string {
  if (!path)
    return '~'
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function ago(ms: number | null): string {
  if (!ms)
    return ''
  const diff = Date.now() - ms
  if (diff < 60_000)
    return 'just now'
  return `${formatDuration(diff).split(' ')[0]} ago`
}

export function cents(value: number): string {
  return `$${(value / 100).toFixed(2)}`
}

export async function loadDashboard(appDir: string = process.cwd()): Promise<DashboardData> {
  const config = loadConfig()
  const [checks, heartbeat, rows] = await Promise.all([
    runChecks(config, appDir),
    readHeartbeat(appDir),
    Run.orderBy('id', 'desc').limit(50).get() as Promise<Array<Record<string, any>>>,
  ])

  const live = isLive(heartbeat)
  const ready = checks.every(check => check.ok)
  const runs = rows.map((row): RunRow => ({
    id: row.id,
    prompt: truncate(row.prompt ?? '', 140),
    where: tildify(row.cwd),
    status: row.status,
    answer: truncate(row.reply ?? row.error ?? '', 220),
    when: ago(row.started_at ?? null),
    took: row.duration_ms ? formatDuration(row.duration_ms) : '',
    cost: typeof row.cost_cents === 'number' ? cents(row.cost_cents) : '',
  }))

  return {
    live,
    headline: !live ? 'Not running' : ready ? 'Listening for texts' : 'Running, setup incomplete',
    checks,
    ready,
    allowed: heartbeat?.allowed ?? config.allowed,
    active: (heartbeat?.active ?? []).map(run => ({
      prompt: truncate(run.prompt, 140),
      elapsed: formatDuration(Date.now() - run.startedAt),
      lastActivity: run.lastActivity ?? 'Thinking',
    })),
    runs,
    totals: {
      runs: rows.length,
      done: rows.filter(row => row.status === 'done').length,
      failed: rows.filter(row => row.status === 'failed').length,
      spend: cents(rows.reduce((sum, row) => sum + (row.cost_cents ?? 0), 0)),
    },
  }
}

function isLive(heartbeat: Heartbeat | null): boolean {
  return !!heartbeat && Date.now() - heartbeat.writtenAt < 60_000
}
