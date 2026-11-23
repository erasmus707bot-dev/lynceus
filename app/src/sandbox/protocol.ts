// Messages between the page and the sandbox worker, and the shape of a test run.
import type { Lang } from '../lib/types';

export type Outcome = 'passed' | 'failed' | 'error' | 'skipped' | 'timeout' | 'crashed';

export interface TestInfo { id: string; file: string; name: string; lang: Lang }

export interface TestResult extends TestInfo {
  outcome: Outcome;
  message: string;  // assertion message or the reason it couldn't run (never empty unless passed)
  output?: string;  // captured print / console output (tail)
  ms?: number;
}

/** Per-file coverage. `lines[n]` lists the test ids that ran line n; '' means "ran at import". */
export interface FileCoverage { statements: number[]; lines: Record<number, string[]> }

export interface RunInput {
  lang: Lang;
  files: { path: string; text: string }[];
  testFiles: string[];     // paths that hold tests (by name pattern or inline test functions)
  skip: string[];          // test ids not to run again (they hung or crashed the sandbox)
  pyodideURL: string;      // self-hosted Pyodide folder (Python only)
  extraWheels?: { file: string; data: Uint8Array }[]; // Python packages the reviewer downloaded from PyPI (packages mode only)
  packagesMode?: boolean;  // the page allows package downloads (changes the missing-package message)
}

export type WorkerEvent =
  | { type: 'status'; msg: string }
  | { type: 'collected'; tests: TestInfo[]; append?: boolean }
  | { type: 'start'; id: string }
  | { type: 'result'; result: TestResult }
  | { type: 'done'; coverage: Record<string, FileCoverage>; notes: string[] }
  | { type: 'fatal'; msg: string };

export const MISSING_PKG_NOTE = 'JavaScript has no package downloads (only the Python side can fetch from PyPI).';
