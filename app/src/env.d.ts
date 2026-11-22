/// <reference types="svelte" />
/// <reference types="vite/client" />
declare const __PYODIDE_VERSION__: string;
declare const __PYODIDE_BYTES__: number;
declare module '*.py?raw' { const src: string; export default src; }
