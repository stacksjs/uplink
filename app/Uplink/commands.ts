/**
 * Texts Uplink answers itself instead of passing to the agent. Only a whole
 * message matches ("stop", "/stop", "Stop."), so "stop the dev server in
 * ~/Code/x" still reaches the agent as a task.
 */
export type ControlCommand = 'help' | 'status' | 'stop' | 'new' | 'more' | 'ping'

const ALIASES: Record<string, ControlCommand> = {
  'help': 'help',
  '?': 'help',
  'commands': 'help',
  'status': 'status',
  'stop': 'stop',
  'cancel': 'stop',
  'abort': 'stop',
  'new': 'new',
  'reset': 'new',
  'clear': 'new',
  'more': 'more',
  'continue reply': 'more',
  'ping': 'ping',
}

export function parseControl(text: string): ControlCommand | null {
  const normalized = text.trim().toLowerCase().replace(/^\//, '').replace(/[.!?]+$/, '').trim()
  return ALIASES[normalized] ?? null
}

export const HELP_TEXT = [
  'Text me anything: a question, or a task for this Mac.',
  'status - what I am doing',
  'stop - cancel the current task and queue',
  'new - start a fresh conversation',
  'more - rest of a long reply',
  'ping - check I am alive',
].join('\n')
