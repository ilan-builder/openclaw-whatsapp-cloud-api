// ---------------------------------------------------------------------------
// Outbound reply directives (PinkLime fork)
//
// Agents embed platform actions as trailing directive lines in their reply
// text (same convention family as the platform's MEDIA: lines). Currently:
//
//   FLOW: <name>     send the named Flow (from channels."whatsapp-cloud".flows)
//                    after delivering the remaining text.
// ---------------------------------------------------------------------------

const FLOW_LINE = /^\s*FLOW:\s*([A-Za-z0-9._-]+)\s*$/;

export interface ParsedDirectives {
  /** reply text with directive lines removed (may be empty) */
  text: string;
  /** flow names referenced, in order of appearance */
  flows: string[];
}

export function extractDirectives(text: string): ParsedDirectives {
  const flows: string[] = [];
  const kept: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(FLOW_LINE);
    if (m) flows.push(m[1]);
    else kept.push(line);
  }
  return { text: kept.join("\n").trim(), flows };
}
