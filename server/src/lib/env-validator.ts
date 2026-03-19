// Minimal env validator — avoids heavy dependencies
export function cleanEnv(env: NodeJS.ProcessEnv, spec: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const [key, validator] of Object.entries(spec)) {
    result[key] = validator(env[key]);
  }
  return result;
}

export function str(opts?: { default?: string }) {
  return (val?: string) => val || opts?.default || '';
}

export function port(opts?: { default?: number }) {
  return (val?: string) => (val ? parseInt(val, 10) : opts?.default || 3000);
}

export function num(opts?: { default?: number }) {
  return (val?: string) => (val ? parseInt(val, 10) : opts?.default || 0);
}
