// Lynceus spike: replace every network-capable global inside a worker with a stub
// that throws, on the global object AND on every prototype that owns it
// (so `WorkerGlobalScope.prototype.fetch.call(self, ...)` is also stubbed).
export function lockNetwork(scope = self) {
  const blocked = (name) => {
    const fn = function () { throw new Error(`network blocked by Lynceus (${name})`); };
    return fn;
  };
  const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
    'WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection'];
  const report = [];
  for (const name of names) {
    const stub = blocked(name);
    let o = scope, hit = false;
    while (o) {
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        try { Object.defineProperty(o, name, { value: stub, writable: false, configurable: false }); hit = true; }
        catch (e) { report.push(`could not stub ${name}: ${e.message}`); }
      }
      o = Object.getPrototypeOf(o);
    }
    if (!hit) { try { Object.defineProperty(scope, name, { value: stub, writable: false, configurable: false }); } catch {} }
  }
  if (scope.navigator && 'sendBeacon' in scope.navigator) {
    try { Object.defineProperty(Object.getPrototypeOf(scope.navigator), 'sendBeacon', { value: blocked('sendBeacon') }); } catch {}
  }
  return report;
}
