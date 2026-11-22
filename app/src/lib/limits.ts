import type { SourceFile } from './types';
import type { Settings } from './settings';

export type LimitLevel = 'ok' | 'warn' | 'stop';
export interface LimitResult { level: LimitLevel; lines: number; files: number; message: string }

export function checkLimits(files: Pick<SourceFile, 'lines'>[], s: Pick<Settings, 'warnLines' | 'maxLines' | 'maxFiles'>): LimitResult {
  const lines = files.reduce((n, f) => n + f.lines, 0);
  const count = files.length;
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (count > s.maxFiles)
    return { level: 'stop', lines, files: count, message: `Too many files: ${fmt(count)} (limit ${fmt(s.maxFiles)}). Upload a smaller part of the project, or raise the limit in Settings.` };
  if (lines > s.maxLines)
    return { level: 'stop', lines, files: count, message: `Too much code: ${fmt(lines)} lines (limit ${fmt(s.maxLines)}). Upload a smaller part of the project, or raise the limit in Settings.` };
  if (lines > s.warnLines)
    return { level: 'warn', lines, files: count, message: `Large input: ${fmt(lines)} lines. Analysis may be slow on a phone.` };
  return { level: 'ok', lines, files: count, message: `${fmt(count)} file${count === 1 ? '' : 's'}, ${fmt(lines)} lines.` };
}
