import { Children, isValidElement, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { ZoomableImage, ZoomableVideo } from "@/components/zoomable-media";

/**
 * Renders user-authored markdown. Server component (no "use client") so the
 * react-markdown + remark-gfm bundle stays on the server — ~50 KB gz never
 * reaches the browser. The output is plain HTML that hydrates without any
 * client JS to drive it, except images and videos: those render through the
 * small client components in zoomable-media.tsx so a scaled-down one can open
 * full size in the Lightbox.
 *
 * Raw HTML in the source is escaped by default (we don't pass rehype-raw) —
 * that's the security boundary. If we want to allow a vetted subset of HTML
 * later, add rehype-sanitize with a strict schema before re-introducing
 * rehype-raw.
 *
 * Inline pre-processing: anywhere we find an @mention (`@handle` or
 * `@"Display Name"`) we wrap the matched text in a styled span so it stands
 * out visually. The parser-side resolves the notification fan-out; this is
 * pure display.
 */
export function Markdown({ children }: { children: string }) {
  const highlighted = highlightMentions(children);
  return (
    <div className="prose prose-slate max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-brand-600 prose-pre:bg-slate-900 prose-pre:text-slate-100 dark:prose-pre:bg-slate-950 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Mentions are emitted as <mention> via the pre-pass below. Without
          // rehype-raw, react-markdown won't recognise raw HTML — so we use a
          // text-only token (a backtick-wrapped string) that we then catch
          // here in the `code` renderer.
          code(props) {
            const { className, children: c, ...rest } = props;
            const text = String(c).trim();
            // Inline code (no language) carrying our mention marker.
            if (!className && text.startsWith("__MENTION__")) {
              const name = text.slice("__MENTION__".length);
              return (
                <span className="mx-0.5 rounded bg-brand-100 px-1 font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-200">
                  @{name}
                </span>
              );
            }
            return (
              <code className={className} {...rest}>
                {c}
              </code>
            );
          },
          // ```mermaid fences become diagrams (client-rendered); every other
          // fenced block keeps the default <pre>.
          pre(props) {
            const { children: kids, node: _node, ...rest } = props;
            const only = Children.toArray(kids)[0];
            if (isValidElement(only)) {
              const p = only.props as { className?: string; children?: ReactNode };
              if (p.className?.split(/\s+/).includes("language-mermaid")) {
                return <MermaidDiagram chart={String(p.children ?? "")} />;
              }
            }
            return <pre {...rest}>{kids}</pre>;
          },
          // `![alt](url?t=video&w=480)` — the same markdown syntax notes use.
          // When the URL carries `t=video|audio` we swap the `<img>` for the
          // matching media element; `w=<px>` clamps the rendered width
          // (responsive via max-width).
          img(props) {
            const src = typeof props.src === "string" ? props.src : "";
            const alt = typeof props.alt === "string" ? props.alt : "";
            const { kind, width } = parseMediaParams(src);
            const style: CSSProperties | undefined = width
              ? { maxWidth: `${width}px`, width: "100%" }
              : undefined;
            if (kind === "video") {
              return <ZoomableVideo src={src} style={style} />;
            }
            if (kind === "audio") {
              return (
                <audio
                  src={src}
                  controls
                  preload="metadata"
                  className="w-full"
                />
              );
            }
            return <ZoomableImage src={src} alt={alt} style={style} />;
          },
        }}
      >
        {highlighted}
      </ReactMarkdown>
    </div>
  );
}

/** Read `t` (kind) and `w` (width px) query params off a media URL. */
function parseMediaParams(
  url: string,
): { kind: "image" | "video" | "audio"; width: number | null } {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return { kind: "image", width: null };
  const params = new URLSearchParams(url.slice(qIdx + 1));
  const t = params.get("t");
  const w = params.get("w");
  const width = w && /^\d+$/.test(w) ? Math.max(1, parseInt(w, 10)) : null;
  const kind = t === "video" ? "video" : t === "audio" ? "audio" : "image";
  return { kind, width };
}

/**
 * Replace bare `@handle` / `@"Display Name"` with inline-code carrying a
 * marker prefix. The Markdown renderer's `code` override paints the result.
 * Going via inline-code keeps us inside react-markdown's parse tree without
 * needing rehype-raw, so the security boundary stays intact.
 */
function highlightMentions(input: string): string {
  let out = input;
  out = out.replace(/@"([^"\n]{1,80})"/g, (_, name: string) => `\`__MENTION__${name}\``);
  out = out.replace(/(^|\s)@([A-Za-z0-9._-]{1,64})/g, (_, lead: string, name: string) =>
    `${lead}\`__MENTION__${name}\``,
  );
  return out;
}
