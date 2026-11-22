/// <reference types="svelte" />
/// <reference types="vite/client" />
declare const __PYODIDE_VERSION__: string;
declare const __PYODIDE_BYTES__: number;
declare module '*.py?raw' { const src: string; export default src; }

// Minimal types for the parts of istanbul and Babel the JS test runner uses (no @types packages needed).
declare module 'istanbul-lib-instrument' {
  export interface Instrumenter { instrumentSync(code: string, filename: string): string; lastFileCoverage(): unknown }
  export function createInstrumenter(opts: Record<string, unknown>): Instrumenter;
}
declare module '@babel/core' {
  export function transformSync(code: string, opts: Record<string, unknown>): { code?: string | null } | null;
}
declare module '@babel/traverse' { const traverse: unknown; export default traverse; }
