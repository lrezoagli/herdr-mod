// Un solo mod, varios roles: cada rol guarda lo suyo con su prefijo ("agents:pins").
export function scoped(role) {
  const ls = globalThis.localStorage;
  const k = (key) => `${role}:${key}`;
  return {
    getItem: (key) => ls.getItem(k(key)),
    setItem: (key, value) => ls.setItem(k(key), value),
    removeItem: (key) => ls.removeItem(k(key)),
  };
}
