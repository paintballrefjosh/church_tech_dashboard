/**
 * Split marker-delimited command output into named sections. Collectors emit
 * `M_<NAME>` sentinel lines between chunks (via `echo`/`Write-Output`) so a
 * single SSH round-trip can carry many command outputs; this reassembles them.
 * Tolerates CRLF (Windows) line endings.
 */
export function splitSections(out: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current = "";
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^M_[A-Z0-9]+$/.test(line.trim())) {
      current = line.trim();
      blocks.set(current, []);
    } else if (current) {
      blocks.get(current)!.push(line);
    }
  }
  return blocks;
}

export function sectionLines(blocks: Map<string, string[]>, name: string): string[] {
  return blocks.get(name) ?? [];
}

/** First non-empty line of a section, trimmed. */
export function sectionFirst(blocks: Map<string, string[]>, name: string): string {
  for (const l of blocks.get(name) ?? []) {
    if (l.trim()) return l.trim();
  }
  return "";
}
