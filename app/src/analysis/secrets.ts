// Possible hardcoded secrets (brief §6.7). Known key formats are "certain" (the format matched);
// name hints and high-entropy strings are "heuristic". Values are never shown in clear: see maskValue.
// The Python analyzer has the same rules in analyze.py (SECRET_PATTERNS); keep the two in step.
import type { Certainty } from './model';

export interface SecretHit { rule: string; label: string; certainty: Certainty }

export const SECRET_PATTERNS: { rule: string; label: string; re: RegExp }[] = [
  { rule: 'secret.aws-key', label: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'secret.github-token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { rule: 'secret.slack-token', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'secret.stripe-key', label: 'Stripe key', re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { rule: 'secret.google-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'secret.openai-key', label: 'API key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { rule: 'secret.private-key', label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'secret.jwt', label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { rule: 'secret.url-credentials', label: 'password inside a URL', re: /\/\/[^/\s:@]+:[^/\s@]{3,}@/ },
];

export const SECRET_NAME = /(secret|token|api[_-]?key|apikey|passw(or)?d|passwd|pwd|private[_-]?key|credential|access[_-]?key|auth[_-]?key|client[_-]?secret)/i;

export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** nameHint: the variable, property or key the string is assigned to, if any. */
export function scanSecret(value: string, nameHint: string | null): SecretHit | null {
  for (const p of SECRET_PATTERNS) if (p.re.test(value)) return { rule: p.rule, label: p.label, certainty: 'certain' };
  const v = value.trim();
  if (nameHint && SECRET_NAME.test(nameHint) && v.length >= 8 && !/\s/.test(v) && !/^[A-Z][A-Z0-9_]*$/.test(v) && !/^(https?:)?\/\//.test(v))
    return { rule: 'secret.name-hint', label: `string assigned to "${nameHint}"`, certainty: 'heuristic' };
  if (v.length >= 20 && !/\s/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !v.includes('://') && (v.match(/\//g) ?? []).length < 3 &&
      !/\.(js|mjs|cjs|py|json|ts|css|html|svelte|md|txt|png|svg)$/i.test(v)) {
    const hex = /^[0-9a-fA-F]+$/.test(v);
    if ((hex && v.length >= 32 && entropy(v) >= 3) || (!hex && entropy(v) >= 4.2))
      return { rule: 'secret.high-entropy', label: 'long random-looking string', certainty: 'heuristic' };
  }
  return null;
}

/** "sk_l••••••••": the first 4 characters only, so you can recognise the kind of key without seeing it. */
export function maskValue(value: string): string {
  return value.slice(0, Math.min(4, Math.floor(value.length / 4))) + '•'.repeat(Math.min(12, Math.max(4, value.length - 4)));
}
