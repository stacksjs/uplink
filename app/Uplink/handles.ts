/**
 * Messages identifies people by handle: an E.164 phone number (`+15551234567`)
 * or an email. The same person shows up spelled differently across `handle`,
 * `chat.chat_identifier` and config (`(555) 123-4567`, `Me@iCloud.com`), so
 * everything is compared in one normal form.
 */
export function normalizeHandle(raw: string): string {
  const handle = raw.trim()
  if (handle.includes('@'))
    return handle.toLowerCase()

  const digits = handle.replace(/[^\d+]/g, '')
  if (!/^\+?\d{7,15}$/.test(digits))
    return handle

  if (digits.startsWith('+'))
    return digits
  // A bare 10-digit number is North American; Messages stores it with +1.
  if (digits.length === 10)
    return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1'))
    return `+${digits}`
  return `+${digits}`
}

export function parseHandleList(value: string | undefined | null): string[] {
  if (!value)
    return []
  return value
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(normalizeHandle)
}

/**
 * True for something Messages can address: an E.164 phone number or an
 * email. `destination_caller_id` and `account` also hold device UUIDs and
 * empty strings, which are no one's handle.
 */
export function isAddressable(handle: string): boolean {
  return /^\+\d{7,15}$/.test(handle) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle)
}
