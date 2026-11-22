// Callers and callees for every function (brief §6.5 Shape). Calls the tool can't resolve stay "unresolved".
import type { Analysis, CallSite, FunctionInfo } from '../analysis/model';

export interface FnRef { fn: FunctionInfo; path: string }
export interface CallerRef { from: FnRef | null; path: string; line: number } // from = null: module-level code
export interface Graph {
  byId: Map<string, FnRef>;
  callees: Map<string, CallSite[]>;
  callers: Map<string, CallerRef[]>;
}

export function buildGraph(analysis: Analysis | null): Graph {
  const g: Graph = { byId: new Map(), callees: new Map(), callers: new Map() };
  if (!analysis) return g;
  for (const fa of analysis.files) for (const fn of fa.functions) g.byId.set(fn.id, { fn, path: fa.path });
  const addCaller = (target: string, ref: CallerRef) => {
    const arr = g.callers.get(target) ?? [];
    if (!arr.some((r) => r.from?.fn.id === ref.from?.fn.id && r.path === ref.path && r.line === ref.line)) arr.push(ref);
    g.callers.set(target, arr);
  };
  for (const fa of analysis.files) {
    for (const fn of fa.functions) {
      g.callees.set(fn.id, fn.callSites ?? []);
      for (const c of fn.callSites ?? []) if (c.target) addCaller(c.target, { from: { fn, path: fa.path }, path: fa.path, line: c.line });
    }
    for (const c of fa.moduleCalls ?? []) if (c.target) addCaller(c.target, { from: null, path: fa.path, line: c.line });
  }
  return g;
}
