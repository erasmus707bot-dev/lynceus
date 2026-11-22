// Shared input model. Later phases add analysis results on top of this.
export type Lang = 'python' | 'javascript';
export type LangChoice = Lang | 'auto';

export interface SourceFile {
  path: string;          // folder structure preserved, '/'-separated, no leading slash
  text: string;
  lang: Lang;
  langSource: 'extension' | 'content (heuristic)' | 'manual';
  lines: number;
  isTest: boolean;
}

export interface SkippedFile { path: string; reason: string }

export interface Workspace {
  files: SourceFile[];
  skipped: SkippedFile[];
  diff: string;
  spec: string;
  loadedAt: number;
  /** Spec bullet ↔ function/test links Scott made or confirmed (Phase 4, Intent pass). Saved only with the session. */
  specLinks?: { item: string; kind: 'function' | 'test'; ref: string; how: 'manual' | 'confirmed suggestion' }[];
}
