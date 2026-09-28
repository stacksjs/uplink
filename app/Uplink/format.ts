/**
 * Shapes agent output for a text message read on a phone, possibly over a
 * satellite link: plain text, no markdown, split into a few short parts.
 */

export function toPlainText(markdown: string): string {
  return markdown
    // Fenced code: keep the code, drop the fences and language tag.
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code: string) => code.trimEnd())
    .replace(/`([^`\n]+)`/g, '$1')
    // Images before links, since an image is a link with a `!`.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    // `[ \t]`, not `\s`: with the m flag, `\s*` also eats the blank line above.
    .replace(/^[ \t]*[-*+][ \t]+/gm, '- ')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Splits text into parts of at most `max` characters, preferring paragraph,
 * then line, then sentence, then word boundaries.
 */
export function chunk(text: string, max: number): string[] {
  const parts: string[] = []
  let rest = text.trim()

  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = lastBoundary(window, '\n\n')
      ?? lastBoundary(window, '\n')
      ?? lastBoundary(window, '. ')
      ?? lastBoundary(window, ' ')
      ?? max
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }

  if (rest)
    parts.push(rest)
  return parts
}

function lastBoundary(window: string, separator: string): number | null {
  const at = window.lastIndexOf(separator)
  // A boundary in the first third makes a uselessly short part.
  if (at < window.length / 3)
    return null
  return at + separator.length
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
