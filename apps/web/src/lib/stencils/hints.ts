/**
 * Guesses that save the admin typing: which side of the switch a picture shows, and what to call the model and match
 * its reported model text with. They are suggestions only; the admin sees and can change every one.
 */
import { emfTexts } from "./emf";
import type { StencilPicture } from "./types";

/** "front" or "back" from the words around a picture, or from what its art prints (power-supply and fan markings mean the back). */
export function guessSide(p: StencilPicture): "front" | "back" | null {
  const words = `${p.name ?? ""} ${p.description ?? ""}`;
  if (/\b(rear|back)\b/i.test(words) && !/\bfront\b/i.test(words)) return "back";
  if (/\bfront\b/i.test(words) && !/\b(rear|back)\b/i.test(words)) return "front";
  if (p.kind === "emf") {
    try {
      const text = emfTexts(p.bytes).join(" ");
      if (/\b(PS OK|AC OK|DC OK|FAIL|FAN ?\d)\b/i.test(text)) return "back";
    } catch {
      /* no hint */
    }
  }
  return null;
}

/** The model's name for a new model: the picture's own name, else the printed model name from the art, else null. */
export function guessName(p: StencilPicture): string | null {
  if (p.name) return p.name;
  if (p.kind === "emf") {
    try {
      const t = emfTexts(p.bytes);
      const at = t.findIndex((s) => /^(Catalyst|Nexus|Cisco|ISR|ASR|Meraki|UniFi)\b/i.test(s.trim()));
      if (at >= 0) return t.slice(at, at + 3).join("").replace(/\s+/g, " ").trim().slice(0, 80);
    } catch {
      /* no hint */
    }
  }
  return null;
}

/** A product id from a name ("WS-C3850-24", "N3K-C3064PQ-10GX") as a match string; names that are words, not ids, give none. */
export function guessMatch(name: string | null): string[] {
  if (!name) return [];
  const t = name.trim();
  return /^[A-Za-z0-9][A-Za-z0-9+._/]*(-[A-Za-z0-9+._/]+)+$/.test(t) && /\d/.test(t) && t.length >= 4 && t.length <= 60 ? [t] : [];
}
