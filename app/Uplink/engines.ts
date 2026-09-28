import type { UplinkConfig } from './config'
import type { Engine, EngineId } from './engine'
import { CodexEngine } from './codex-engine'
import { systemPrompt } from './config'
import { ClaudeEngine } from './engine'
import { ENGINE_IDS } from './engine'

/**
 * Builds engines from config, so the watcher, the app and the doctor all select
 * one the same way. Both construction sites used to say `new ClaudeEngine(...)`
 * with their own copy of the options, which is two places to forget.
 */

export function engineFor(id: EngineId, config: UplinkConfig): Engine {
  const prompt = systemPrompt(config)
  if (id === 'codex') {
    return new CodexEngine({
      bin: config.codexBin,
      model: config.codexModel,
      permission: config.codexPermission,
      systemPrompt: prompt,
      timeoutMs: config.timeoutMs,
    })
  }
  return new ClaudeEngine({
    bin: config.claudeBin,
    model: config.claudeModel,
    permissionMode: config.permissionMode,
    systemPrompt: prompt,
    timeoutMs: config.timeoutMs,
  })
}

/** The configured engine. */
export function selectedEngine(config: UplinkConfig): Engine {
  return engineFor(config.engine, config)
}

/**
 * Every engine, selected one first. The doctor and the menubar report on all of
 * them: an engine the person has not set up is information, not a failure, and
 * seeing that the other one is available is how they learn they can switch.
 */
export function allEngines(config: UplinkConfig): Engine[] {
  const ordered = [config.engine, ...ENGINE_IDS.filter(id => id !== config.engine)]
  return ordered.map(id => engineFor(id, config))
}
