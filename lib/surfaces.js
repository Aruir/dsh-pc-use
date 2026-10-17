// cua_repl advertises its enabled surfaces through CUA_REPL_ENABLED_SURFACES. Codex ships
// `browser`; the plugin may add `computer` (Windows desktop control) on top of it.
//
// The desktop `sky` service must also be listed in NODE_REPL_TRUSTED_SERVICES. Codex's
// `.mcp.json` already writes that variable, so the launcher never generates it from the
// surfaces: the plugin has to add `sky` itself.

const SKY_SERVICE = '@oai/sky/service'
const INVALID_TRUSTED_SERVICES =
  'dsh-codex-cu: NODE_REPL_TRUSTED_SERVICES is not a JSON object; computer use cannot be enabled'

/** Add the computer surface to a comma list, preserving order. O(n), n = surfaces. */
export function enableComputerSurface(value) {
  const surfaces = []
  if (typeof value === 'string') {
    for (const item of value.split(',')) {
      const surface = item.trim()
      if (surface !== '' && !surfaces.includes(surface)) surfaces.push(surface)
    }
  }
  if (!surfaces.includes('computer')) surfaces.push('computer')
  return surfaces.join(',')
}

/** Parse the trusted-services env value; null when absent or not a JSON object. O(n). */
function parseTrustedServices(raw) {
  if (typeof raw !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

/**
 * Merge the sky service into NODE_REPL_TRUSTED_SERVICES when computer use is on.
 * O(n), n = trusted service names. Returns the value to pass down, its names and where
 * those names came from (`env` or `launcher`); throws (without echoing the value) when
 * the variable is not a JSON object.
 */
export function mergeTrustedServices(raw, computer) {
  if (raw === undefined) {
    // No variable at all: the launcher generates the trusted services from the surfaces.
    return { value: undefined, names: null, source: 'launcher' }
  }
  const parsed = parseTrustedServices(raw)
  if (computer !== true) {
    const names = parsed === null ? null : Object.keys(parsed)
    return { value: raw, names, source: 'env' }
  }
  if (parsed === null) {
    throw new Error(INVALID_TRUSTED_SERVICES)
  }
  if (!Object.hasOwn(parsed, 'sky')) {
    parsed.sky = SKY_SERVICE
  }
  return { value: JSON.stringify(parsed), names: Object.keys(parsed), source: 'env' }
}
