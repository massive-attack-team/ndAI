export interface Edit { start: number; end: number; replacement: string }

/** Where two edits overlap (an email inside a flagged sentence), the widest wins. */
export function keepWidest<T extends Edit>(edits: T[]): T[] {
  const kept: T[] = [];
  for (const e of [...edits].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (!kept.some((k) => e.start < k.end && k.start < e.end)) kept.push(e);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function applyEdits(text: string, edits: Edit[], tidySpaces = false): string {
  let out = text;
  for (const e of keepWidest(edits).reverse()) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return tidySpaces ? out.replace(/[ \t]{2,}/g, " ") : out;
}
