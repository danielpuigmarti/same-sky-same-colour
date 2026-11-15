// A small JSON Schema checker. It knows only the keywords that the schemas in tests/vectors/schema/ use, and
// refuses a schema that uses any other, so a rule is never skipped without notice.
// pipeline/sx/contracts.py holds the same checker in Python; both are run on the same files.

const NOTES = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description']);

const KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties', 'propertyNames',
  'items', 'minItems', 'maxItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'pattern',
]);

/** @param {unknown} v */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'not-finite';
  return typeof v; // string, boolean, object
}

/** @param {unknown} v @param {string} t */
function isType(v, t) {
  const k = typeOf(v);
  return t === 'integer' ? k === 'number' && Number.isInteger(v) : k === t;
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Check a value against a schema.
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {Record<string, any>} [root] the schema that `$ref` paths start from
 * @param {string} [at] where the value sits, for the messages
 * @returns {string[]} one message per problem; empty when the value is valid
 */
export function validate(value, schema, root = schema, at = '$') {
  /** @type {string[]} */
  const out = [];
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k) && !NOTES.has(k)) throw new Error(`schema keyword not supported: ${k}`);
  }
  if (schema.$ref !== undefined) {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref);
    if (!m || !root.$defs?.[m[1]]) throw new Error(`schema $ref not supported: ${schema.$ref}`);
    out.push(...validate(value, root.$defs[m[1]], root, at));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((/** @type {string} */ t) => isType(value, t))) {
      out.push(`${at}: expected ${types.join(' or ')}, found ${typeOf(value)}`);
      return out;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((/** @type {unknown} */ e) => same(e, value))) {
    out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && !same(schema.const, value)) {
    out.push(`${at}: expected ${JSON.stringify(schema.const)}, found ${JSON.stringify(value)}`);
  }
  const kind = typeOf(value);
  if (kind === 'number') {
    const n = /** @type {number} */ (value);
    if (schema.minimum !== undefined && n < schema.minimum) out.push(`${at}: ${n} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && n > schema.maximum) out.push(`${at}: ${n} is above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum) out.push(`${at}: ${n} is not above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum) out.push(`${at}: ${n} is not below ${schema.exclusiveMaximum}`);
  }
  if (kind === 'string') {
    const s = /** @type {string} */ (value);
    if (schema.minLength !== undefined && [...s].length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(s)) out.push(`${at}: ${JSON.stringify(s)} does not match ${schema.pattern}`);
  }
  if (kind === 'array') {
    const a = /** @type {unknown[]} */ (value);
    if (schema.minItems !== undefined && a.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && a.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined) a.forEach((v, i) => out.push(...validate(v, schema.items, root, `${at}[${i}]`)));
  }
  if (kind === 'object') {
    const o = /** @type {Record<string, unknown>} */ (value);
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) if (!Object.hasOwn(o, k)) out.push(`${at}: "${k}" is missing`);
    for (const [k, v] of Object.entries(o)) {
      const where = `${at}.${k}`;
      if (schema.propertyNames !== undefined) out.push(...validate(k, schema.propertyNames, root, `${at}: key "${k}"`));
      if (Object.hasOwn(props, k)) out.push(...validate(v, props[k], root, where));
      else if (schema.additionalProperties === false) out.push(`${where}: not a known field`);
      else if (typeof schema.additionalProperties === 'object') out.push(...validate(v, schema.additionalProperties, root, where));
    }
  }
  return out;
}
