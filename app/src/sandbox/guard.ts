// Network lockdown for the sandbox worker (brief §5), proven in Phase 0 (docs/PHASE0_REPORT.md).
// Every network-capable global is replaced with a stub that throws, on the global object AND on
// every prototype that owns it, so `WorkerGlobalScope.prototype.fetch.call(self, …)` is stubbed too.
// This is the second layer: the page's CSP (connect-src 'self') is the first, and still applies
// because the sandbox worker is started from a blob: URL.

export const BLOCKED_MSG = 'network blocked by Lynceus';

const NAMES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
  'WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'BroadcastChannel'];

function stubEverywhere(scope: object, name: string, stub: unknown, report: string[]): void {
  let o: object | null = scope, hit = false;
  while (o) {
    if (Object.prototype.hasOwnProperty.call(o, name)) {
      try { Object.defineProperty(o, name, { value: stub, writable: false, configurable: false }); hit = true; }
      catch (e) { report.push(`could not stub ${name}: ${(e as Error).message}`); }
    }
    o = Object.getPrototypeOf(o);
  }
  if (!hit) { try { Object.defineProperty(scope, name, { value: stub, writable: false, configurable: false }); } catch { /* not present */ } }
}

/** Returns a list of anything that could not be stubbed (empty when fully locked). */
export function lockNetwork(scope: typeof globalThis = globalThis): string[] {
  const report: string[] = [];
  for (const name of NAMES) {
    const stub = function () { throw new Error(`${BLOCKED_MSG} (${name})`); };
    stubEverywhere(scope, name, stub, report);
  }
  // Workers usually have no navigator.sendBeacon; define the stub anyway so any attempt fails the same clear way.
  const nav = (scope as { navigator?: object }).navigator;
  if (nav) stubEverywhere(nav, 'sendBeacon', function () { throw new Error(`${BLOCKED_MSG} (sendBeacon)`); }, report);
  return report;
}

/**
 * Takes the worker's postMessage for Lynceus's own use and stubs it for everything that runs
 * afterwards, so user code can't send fake test results to the page.
 */
export function takePostMessage(scope: typeof globalThis = globalThis): (msg: unknown) => void {
  const g = scope as unknown as { postMessage?: (m: unknown) => void };
  const real = g.postMessage!.bind(scope);
  const report: string[] = [];
  stubEverywhere(scope, 'postMessage', function () { throw new Error('postMessage is reserved by Lynceus'); }, report);
  return real;
}
