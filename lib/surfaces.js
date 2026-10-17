// cua_repl advertises its enabled surfaces through CUA_REPL_ENABLED_SURFACES. Codex ships
// `browser`; the plugin may add `computer` (Windows desktop control) on top of it.

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
