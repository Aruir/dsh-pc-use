// Shared access to the optional DSH context services. Desktop approvals and image projection
// both ask for services by name, and a throwing service getter must not break a call.

/** Read one optional context service without letting a service getter throw. O(1). */
export function readService(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}
