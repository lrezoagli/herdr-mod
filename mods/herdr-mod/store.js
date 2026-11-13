// One mod, several roles: each role stores its data under its own prefix ("agents:pins").
export function scoped(role) {
  const ls = globalThis.localStorage;
  const k = (key) => `${role}:${key}`;
  return {
    getItem: (key) => ls.getItem(k(key)),
    setItem: (key, value) => ls.setItem(k(key), value),
    removeItem: (key) => ls.removeItem(k(key)),
  };
}
