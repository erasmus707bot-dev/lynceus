import type { FileAnalysis } from './model';
import type { SourceFile } from '../lib/types';

/** Adding a language = adding one of these. */
export interface LanguageAdapter {
  lang: SourceFile['lang'];
  /** Analyze all files of this language together (so calls between files resolve). */
  analyze(files: SourceFile[]): Promise<FileAnalysis[]>;
}
