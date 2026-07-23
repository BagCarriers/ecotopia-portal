/**
 * Ecotopia Portal - key mapping between DB rows (snake_case) and page objects (camelCase).
 * Top-level keys only; values (including jsonb arrays/objects) pass through untouched.
 * Loadable in the browser (script tag) and in Node (require) for tests.
 */
(function (root) {
  const snakeKey = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

  function mapKeys(obj, fn) {
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[fn(k)] = v;
    return out;
  }

  root.EcoMapping = {
    toDb: (obj) => mapKeys(obj, snakeKey),
    fromDb: (row) => mapKeys(row, camelKey),
    fromDbAll: (rows) => (rows || []).map((r) => mapKeys(r, camelKey)),
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
