/**
 * Split on whitespace, but keep anything inside `()` whole so a
 * `minmax(1fr, 2fr)` track list or `rgba(0, 0, 0, .1)` colour stays as one
 * token instead of being torn apart at its internal spaces.
 */
export function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of raw) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (token) out.push(token);
      token = "";
      continue;
    }
    token += ch;
  }
  if (token) out.push(token);
  return out;
}
