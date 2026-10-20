/** A declared field type. `?` marks it optional. */
export type FieldType = 'string' | 'string?' | 'number' | 'number?';

export type FieldValue<T extends FieldType> =
  T extends 'string' ? string : T extends 'string?' ? string | undefined
    : T extends 'number' ? number : number | undefined;

function matches(type: FieldType, value: unknown): boolean {
  if (value === undefined) return type.endsWith('?');
  return type.startsWith('string')
    ? typeof value === 'string'
    : typeof value === 'number' && Number.isFinite(value);
}

/** Fields of `data` that do not match their declared type. Undeclared fields are allowed. */
export function invalidFields(
  fields: Readonly<Record<string, FieldType>>, data: Record<string, unknown>,
): string[] {
  return Object.entries(fields)
    .filter(([name, type]) => !matches(type, data[name]))
    .map(([name]) => name);
}
