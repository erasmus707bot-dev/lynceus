// Babel reads a few `process` fields. The sandbox worker has no `process`, so give it a harmless one.
const g = globalThis as unknown as { process?: unknown };
if (!g.process) {
  g.process = { env: { NODE_ENV: 'production' }, cwd: () => '/', platform: 'browser', version: 'v0.0.0', versions: {}, argv: [], emitWarning() {}, nextTick: (f: (...a: unknown[]) => void, ...a: unknown[]) => { Promise.resolve().then(() => f(...a)); } };
}
export {};
