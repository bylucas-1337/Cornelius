export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(schema);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return {};
  return Object.fromEntries(Object.entries(sanitized));
}

function sanitizeValue(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeValue);
  if (!schema || typeof schema !== 'object') return schema;
  const unsupportedKeys = new Set([
    '$schema',
    '$defs',
    '$ref',
    'uniqueItems',
    'minItems',
    'minLength',
    'maxLength',
    'maxItems',
    'pattern',
    'strict',
    'additionalProperties',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
  ]);
  const fields = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const type = fields.type;
  if (Array.isArray(type)) {
    const nonNullType = type.find((entry) => entry !== 'null');
    if (typeof nonNullType === 'string') result.type = nonNullType.toUpperCase();
    if (type.includes('null')) result.nullable = true;
  } else if (typeof type === 'string') {
    result.type = type.toUpperCase();
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'type' || unsupportedKeys.has(key)) continue;
    if (key === 'const') {
      if (typeof value === 'string') result.enum = [value];
    } else if (key === 'enum' && Array.isArray(value)) {
      const enumValues = value.filter((entry): entry is string => typeof entry === 'string');
      if (enumValues.length > 0) result.enum = enumValues;
    } else {
      result[key] = sanitizeValue(value);
    }
  }
  return result;
}
