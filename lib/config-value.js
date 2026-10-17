// Configuration values reach `apply` in one of two shapes:
//   - the host could not resolve `@deepseek-ai/schemastery`, so cordis passes the raw
//     config object and every value is the value the user wrote;
//   - the host resolved schemastery, so cordis validates the config first and every
//     `.volatile()` leaf arrives as a cosmokit Volatile reference.
// Volatile references are live: the loader rewrites them in place, so they must be read
// through `.get()` at the moment the value is used, not captured during `apply`.

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** True when `value` implements cosmokit's Volatile protocol. */
export function isVolatile(value) {
  if (typeof value !== 'object' || value === null) return false
  if (typeof value.get !== 'function') return false
  return VOLATILE_WRITE in value
}

/** Unwrap a Volatile reference; return every other value unchanged. */
export function unwrapConfigValue(value) {
  return isVolatile(value) ? value.get() : value
}
