import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithOrigin(origin, fn) {
  return storage.run({ origin }, fn);
}

export function configuredOrigin() {
  return (process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
}

export function publicOrigin() {
  const configured = configuredOrigin();
  if (configured) return configured;
  const origin = storage.getStore()?.origin;
  if (!origin) throw new Error('origin missing');
  return origin;
}
