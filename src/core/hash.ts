export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undef';

  switch (typeof value) {
    case 'number': {
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return 'Inf';
      if (value === -Infinity) return '-Inf';
      if (Object.is(value, -0)) return '-0';
      return String(value);
    }
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'string':
      return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => k + ':' + stableStringify(obj[k])).join(',') + '}';
  }

  return String(value);
}

function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Non-cryptographic; suitable for cache keys, not for integrity checks. */
export function hash64(input: string): string {
  const lo = fnv1a(input, 0x811c9dc5);
  const hi = fnv1a(input, 0x9e3779b9);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}
