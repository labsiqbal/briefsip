const logged = new Set();

export function productEnv(name, env = process.env) {
  if (!name.startsWith('MINARBOT_') || env[name] !== undefined) return env[name];
  const legacy = 'BRIEFSIP_' + name.slice('MINARBOT_'.length);
  const value = env[legacy];
  if (value !== undefined && !logged.has(legacy)) {
    logged.add(legacy);
    console.warn(`[minarbot] ${legacy} is deprecated. Use ${name}.`);
  }
  return value;
}
