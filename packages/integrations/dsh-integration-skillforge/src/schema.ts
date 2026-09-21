/**
 * JSON-Schema extraction for registered DSH tools.
 * DSH tools declare their arguments as a raw JSON Schema object
 * (`ToolDefinition.parameters`); this module extracts the fields the
 * guard and profiler need: required keys, per-property enums, defaults,
 * and descriptions.
 * @module @deepseek-ai/dsh-integration-skillforge/schema
 */

export interface PropertySpec {
  type?: string
  enum?: unknown[]
  default?: unknown
  description?: string
}

export interface ToolArgumentSchema {
  /** Keys the tool itself declares as required. */
  required: string[]
  /** Per-property spec: type, allowed enum values, default, description. */
  properties: Record<string, PropertySpec>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Extract the guard-relevant subset from a tool's JSON Schema parameters.
 * Returns an empty schema for an absent definition (tool not registered).
 */
export function parseToolSchema(
  parameters: Record<string, unknown> | undefined,
): ToolArgumentSchema {
  if (parameters === undefined) return { required: [], properties: {} }

  const requiredRaw = parameters['required']
  const required = new Set<string>(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((key): key is string => typeof key === 'string')
      : [],
  )

  const properties: Record<string, PropertySpec> = {}
  const rawProperties = parameters['properties']
  if (isRecord(rawProperties)) {
    for (const [key, raw] of Object.entries(rawProperties)) {
      if (!isRecord(raw)) continue
      const spec: PropertySpec = {}
      if (typeof raw['type'] === 'string') spec.type = raw['type']
      if (Array.isArray(raw['enum'])) spec.enum = [...raw['enum']]
      if ('default' in raw) spec.default = raw['default']
      if (typeof raw['description'] === 'string') spec.description = raw['description']
      properties[key] = spec
      // Schemastery-style per-property required (DSH first-party tools):
      // `{ url: { type: 'string', required: true } }` carries required-ness
      // on the property, not in a top-level array.
      if (raw['required'] === true) required.add(key)
    }
  }
  // Schemastery inline form without a `properties` wrapper: the parameters
  // object itself is the property map (`{ url: { type, required } }`).
  if (rawProperties === undefined) {
    for (const [key, raw] of Object.entries(parameters)) {
      if (!isRecord(raw) || raw['required'] !== true) continue
      required.add(key)
    }
  }

  return { required: [...required], properties }
}

/**
 * Values of `parameters` that violate the schema's enum constraint.
 * @returns the violating key names (unknown keys and absent keys are ignored —
 * required-ness is checked separately).
 */
export function enumViolations(
  parameters: Record<string, unknown>,
  schema: ToolArgumentSchema,
): string[] {
  const violations: string[] = []
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (spec.enum === undefined || !(key in parameters)) continue
    const value = parameters[key]
    const matches = spec.enum.some(allowed =>
      JSON.stringify(allowed) === JSON.stringify(value),
    )
    if (!matches) violations.push(key)
  }
  return violations
}
