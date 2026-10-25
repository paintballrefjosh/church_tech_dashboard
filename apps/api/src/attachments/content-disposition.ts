/**
 * A `Content-Disposition` value that every browser saves under the real name (RFC 6266): `filename*` carries the name
 * percent-encoded as UTF-8, and `filename` an ASCII stand-in for clients that ignore it. Percent-encoding inside
 * `filename="..."` alone, as the routes used to, made Firefox and Safari save `My%20Report.pdf`.
 */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_").trim() || "download";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The file name out of a `Content-Disposition` header: `filename*` first, then a plain (or old percent-encoded) `filename`. */
export function filenameFromDisposition(header: string | undefined): string {
  const h = header ?? "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      /* fall through to the plain name */
    }
  }
  const m = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  if (!m) return "attachment";
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}
