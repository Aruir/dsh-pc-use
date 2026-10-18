// Workspace-linked plugins may not resolve the host's dsh-tools package.
// Keep the fallback registry-ready: parameters DSL is not JSON Schema.
export function definePortableTool(spec, defineTool = null) {
  if (typeof defineTool === 'function') return defineTool(spec)

  const properties = {}
  const required = []
  for (const [key, parameter] of Object.entries(spec.parameters)) {
    const { required: mandatory, ...schema } = parameter
    // Keep the fallback aligned with the host's JSON-value schema DSL.
    if (!['string', 'number', 'boolean', 'array', 'object'].includes(schema.type)) {
      throw new TypeError(`Unsupported parameter type: ${spec.name}.${key}`)
    }
    if (mandatory !== undefined && mandatory !== true) {
      throw new TypeError(`Invalid required flag: ${spec.name}.${key}`)
    }
    properties[key] = schema
    if (mandatory === true) required.push(key)
  }
  const parameters = {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  }

  return {
    ...spec,
    parameters,
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('Tool arguments must be an object')
      }
      for (const [key, schema] of Object.entries(properties)) {
        const present = Object.hasOwn(args, key)
        if (!present && required.includes(key)) {
          throw new TypeError(`Missing required parameter: ${key}`)
        }
        if (present && schema.type === 'array' && !Array.isArray(args[key])) {
          throw new TypeError(`Invalid parameter: ${key} must be array`)
        }
        if (present && schema.type === 'object'
            && (typeof args[key] !== 'object' || args[key] === null || Array.isArray(args[key]))) {
          throw new TypeError(`Invalid parameter: ${key} must be object`)
        }
        if (present && ['string', 'number', 'boolean'].includes(schema.type)
            && (typeof args[key] !== schema.type
              || (schema.type === 'number' && !Number.isFinite(args[key])))) {
          throw new TypeError(`Invalid parameter: ${key} must be ${schema.type}`)
        }
      }
      return spec.execute(args, exec)
    },
  }
}
