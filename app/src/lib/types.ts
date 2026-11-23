// Shared input model. Later phases add analysis results on top of this.
export type Lang = 'python' | 'javascript';
/** 'typescript' is a paste-box choice only: the file gets a .ts name and is reviewed by the JavaScript adapter. */
export type LangChoice = Lang | 'typescript' | 'auto';

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
  /** Phase 5 review progress, by function id. Saved only when "Remember" is on, like everything on the workspace. */
  reviews?: Record<string, { done: boolean; note: string }>;
}
