#!/usr/bin/env node
/**
 * WCAG contrast check for the home page looks.
 *
 * Reads the light token set (`.root { --x: ... }`) and the dark one (`:global(.dark) .root`) out of each
 * look's CSS Module, then computes the contrast of the text/background pairs that look actually uses.
 * The pairs are listed by hand below (a check that guessed them would pass things nobody reads).
 *
 *   text            >= 4.5:1  (body and small text)
 *   large           >= 3:1    (>= 24 px, or >= 19 px bold)
 *   ui              >= 3:1    (non-text indicators: focus rings, status dots, control edges)
 *
 * A token may be a hex colour, rgba(), or a gradient (every colour stop is tried and the worst ratio counts).
 * A translucent background is laid over the pair's `over` token (default: the look's page background).
 * `screen: true` applies the look's `.screen` overrides (Front of House keeps dark screens in both schemes).
 *
 * Usage: node scripts/check-look-contrast.mjs [--json]   (exit code 1 when any pair fails)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web/src/app/home/looks");

// ---------------------------------------------------------------- colour maths
function parseColors(value) {
  const out = [];
  const re = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/gi;
  let m;
  while ((m = re.exec(value))) {
    if (m[1]) {
      let h = m[1];
      if (h.length === 3) h = [...h].map((c) => c + c).join("");
      out.push({
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      });
    } else {
      out.push({ r: +m[2], g: +m[3], b: +m[4], a: m[5] === undefined ? 1 : +m[5] });
    }
  }
  return out;
}
const over = (top, under) => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});
const lum = ({ r, g, b }) => {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// ---------------------------------------------------------------- token parsing
function block(css, selector) {
  const i = css.indexOf(selector + " {");
  if (i < 0) return {};
  const end = css.indexOf("}", i);
  const body = css.slice(i + selector.length + 2, end);
  const tokens = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  return tokens;
}

function tokenSet(css, scheme, screen) {
  const light = block(css, ".root");
  const merged = scheme === "dark" ? { ...light, ...block(css, ":global(.dark) .root") } : light;
  return screen ? { ...merged, ...block(css, ".screen") } : merged;
}

function resolve(tokens, name, seen = new Set()) {
  let v = tokens[name];
  if (v === undefined || seen.has(name)) return undefined;
  seen.add(name);
  v = v.replace(/var\((--[\w-]+)\)/g, (_, n) => resolve(tokens, n, seen) ?? "");
  return v;
}

/** A spec is "--token" or a literal colour; returns every colour it can paint. */
function colorsOf(tokens, spec) {
  const text = spec.startsWith("--") ? resolve(tokens, spec) : spec;
  if (text === undefined) throw new Error(`unknown token ${spec}`);
  const list = parseColors(text);
  if (list.length === 0) throw new Error(`no colour in ${spec}: ${text}`);
  return list;
}

// ---------------------------------------------------------------- the pairs
const T = 4.5;
const L = 3;
const U = 3;

/** [foreground, background, minimum, what it is, extra options] */
const LOOKS = [
  {
    id: "start",
    file: "start/styles.module.css",
    page: "--bg",
    pairs: [
      ["--ink", "--bg", T, "body text on page"],
      ["--ink", "--surface", T, "body text on card"],
      ["--ink-2", "--bg", T, "muted text on page (summary, kbd)"],
      ["--ink-2", "--surface", T, "muted text on card"],
      ["--ink-3", "--bg", T, "faint text on page (group heading, tagline)"],
      ["--ink-3", "--surface", T, "faint text on card (counts, small)"],
      ["--brand", "--surface", T, "link text on card"],
      ["--brand", "--bg", T, "link text on page (picker)"],
      ["--brand-2", "--surface", T, "link hover on card"],
      ["--brand-2", "--brand-soft", T, "link hover on tinted tok"],
      ["--hot", "--surface", T, "due text on card"],
      ["--wait", "--surface", T, "waiting text on card"],
      ["#ffffff", "--btn", T, "primary button text"],
      ["#ffffff", "--btn-2", T, "primary button hover text"],
      ["--ink", "--surface", T, "secondary button text"],
      ["--hot", "--hot-soft", U, "urgent icon on its tint"],
      ["--wait", "--wait-soft", U, "waiting icon on its tint"],
      ["--good", "--good-soft", U, "task icon on its tint"],
      ["--brand", "--brand-soft", U, "default icon on its tint"],
      ["--good", "--surface", U, "status dot, calm"],
      ["--hot", "--surface", U, "status dot, urgent"],
      ["--wait-bar", "--surface", U, "team bar, waiting"],
      ["--ring", "--bg", U, "focus ring on page"],
      ["--ring", "--surface", U, "focus ring on card"],
      ["--field-edge", "--surface", U, "search field edge"],
    ],
  },
  {
    id: "nave",
    file: "nave/nave.module.css",
    page: "--night",
    pairs: [
      ["--stone", "--night", T, "body text on page"],
      ["--stone", "--bay-2", T, "body text on window"],
      ["--stone-2", "--night", T, "muted text on page"],
      ["--stone-2", "--bay-2", T, "muted text on window"],
      ["--stone-2", "--plain-bg", T, "muted text on plain panel", { over: "--night" }],
      ["--stone-3", "--night", T, "faint text on page"],
      ["--stone-3", "--bay-2", T, "faint text on window"],
      ["--stone-3", "--plain-bg", T, "faint text on plain panel", { over: "--night" }],
      ["--head", "--night", L, "hero title (large)"],
      ["--head", "--bay-2", T, "window title"],
      ["--candle", "--night", T, "gold text on page"],
      ["--candle", "--bay-2", T, "gold text on window"],
      ["--candle-2", "--night", T, "gold hover/times text on page"],
      ["--candle-2", "--bay-2", T, "gold hover text on window"],
      ["--peri", "--night", T, "link text on page"],
      ["--peri", "--bay-2", T, "link text on window"],
      ["--ok", "--bay-2", T, "ok text on window"],
      ["--ok", "--night", T, "ok text on page"],
      ["--ember", "--night", T, "alert text on page"],
      ["--ember", "--bay-2", T, "alert text on window"],
      ["#2a1d05", "--gold", T, "primary button text"],
      ["--focus", "--night", U, "focus ring on page"],
      ["--focus", "--bay-2", U, "focus ring on window"],
      ["--lamp", "--bay-2", U, "lamp indicator on window"],
    ],
  },
  {
    id: "toward-sunday",
    file: "toward-sunday/toward-sunday.module.css",
    page: "--paper",
    pairs: [
      ["--ink", "--paper", T, "body text on page"],
      ["--ink", "--surface", T, "body text on panel"],
      ["--ink", "--today", T, "text on today cell"],
      ["--ink-2", "--paper", T, "muted text on page"],
      ["--ink-2", "--surface", T, "muted text on panel"],
      ["--ink-2", "--past", T, "muted text on past cell"],
      ["--ink-2", "--today", T, "muted text on today cell"],
      ["--ink-3", "--paper", T, "faint text on page"],
      ["--ink-3", "--surface", T, "faint text on panel"],
      ["--ink-3", "--past", T, "faint text on past cell"],
      ["--cobalt", "--paper", T, "link text on page"],
      ["--cobalt", "--surface", T, "link text on panel"],
      ["--cobalt", "--cobalt-soft", T, "link text on tint"],
      ["--sun-ink", "--sun-soft", T, "sunday label on tint"],
      ["--sun-ink", "--sunday-bg", T, "sunday label on cell"],
      ["--sun-ink", "--now-chip", T, "now chip text"],
      ["--sun-ink", "--due-bg", T, "due text"],
      ["--ok", "--surface", T, "ok text on panel"],
      ["--ok", "--ok-soft", T, "ok text on tint"],
      ["--warn", "--surface", T, "warning text on panel"],
      ["--warn", "--warn-soft", T, "warning text on tint"],
      ["--down", "--surface", T, "down text on panel"],
      ["--down", "--down-soft", T, "down text on tint"],
      ["--sum-ink", "--sum-bg", T, "readiness text"],
      ["--sum-ink-2", "--sum-bg", T, "readiness muted text"],
      ["--sum-score", "--sum-bg", L, "readiness score (large)"],
      ["--sum-on", "--sum-bg", U, "readiness segment, on"],
      ["--sum-off", "--sum-bg", 1.2, "readiness segment, off (decorative)"],
      ["--cobalt", "--paper", U, "focus ring on page"],
      ["--cobalt", "--surface", U, "focus ring on panel"],
    ],
  },
  {
    id: "glass",
    file: "glass/glass.module.css",
    page: "--paper",
    pairs: [
      ["--ink", "--paper", T, "body text on page"],
      ["--ink", "--pane", T, "body text on pane"],
      ["--ink", "--svc-wash", T, "text on service pane"],
      ["--ink", "--tile", T, "text on tile"],
      ["--ink-2", "--paper", T, "muted text on page"],
      ["--ink-2", "--pane", T, "muted text on pane"],
      ["--ink-2", "--svc-wash", T, "muted text on service pane"],
      ["--ink-2", "--tile", T, "muted text on tile"],
      ["--ink-2", "--neutral-soft", T, "status chip text"],
      ["--ink-3", "--pane", T, "faint text on pane"],
      ["--link", "--paper", T, "link text on page"],
      ["--link", "--pane", T, "link text on pane"],
      ["--link", "--svc-wash", T, "link text on service pane"],
      ["--ruby-text", "--pane", T, "alert text on pane"],
      ["--ruby-text", "--paper", T, "alert text on page"],
      ["--ruby-text", "--ruby-soft", T, "alert chip text"],
      ["#ffffff", "--lead", T, "button/countdown text on lead"],
      ["rgba(255, 255, 255, 0.75)", "--lead", T, "countdown label on lead", { over: "--lead" }],
      ["--axis", "--lead", T, "window axis labels", { over: "--lead" }],
      ["--on-glass", "--cobalt", U, "icon on cobalt chip"],
      ["--on-glass", "--emerald", U, "icon on emerald chip"],
      ["--on-glass", "--amethyst", U, "icon on amethyst chip"],
      ["--lead", "--amber", U, "icon on amber chip (dark ink)"],
      ["--on-glass", "--ruby", U, "icon on ruby chip"],
      ["--link", "--paper", U, "focus ring on page"],
      ["--link", "--pane", U, "focus ring on pane"],
      ["--servers-0", "--out-bg", U, "lit pane against a down pane: servers"],
      ["--internet-0", "--out-bg", U, "lit pane against a down pane: internet"],
      ["--wifi-0", "--out-bg", U, "lit pane against a down pane: wifi"],
      ["--switches-0", "--out-bg", U, "lit pane against a down pane: switches"],
      ["--dns-0", "--out-bg", U, "lit pane against a down pane: dns"],
      ["--services-0", "--out-bg", U, "lit pane against a down pane: services"],
      ["#ff5a6e", "--lead", U, "down pane ring"],
    ],
  },
  {
    id: "front-of-house",
    file: "front-of-house/front-of-house.module.css",
    page: "--console",
    pairs: [
      ["--label", "--console", T, "body text on console"],
      ["--label", "--panel", T, "body text on card"],
      ["--strong", "--panel", T, "strong text on card"],
      ["--dim", "--console", T, "muted text on console"],
      ["--dim", "--panel", T, "muted text on card"],
      ["--dim", "--chip", T, "muted text on chip"],
      ["--dimmer", "--panel", T, "faint text on card"],
      ["--dimmer", "--console", T, "faint text on console"],
      ["--t-amber", "--panel", T, "amber text on card"],
      ["--t-red", "--panel", T, "red text on card"],
      ["--t-cyan", "--panel", T, "link text on card"],
      ["--t-ok", "--panel", T, "ok text on card"],
      ["--key-ink", "--key-top", T, "key button text"],
      ["--key-ink", "--key-bottom", T, "key button text (low edge)"],
      ["--label", "--chip", T, "chip text"],
      ["--focus", "--console", U, "focus ring on console"],
      ["--focus", "--panel", U, "focus ring on card"],
      ["--box-edge", "--panel", U, "control edge on card"],
      // The physical screens (scene, meter boxes, alert log) stay dark in both schemes.
      ["--label", "--screen", T, "screen text", { screen: true }],
      ["--dim", "--screen", T, "screen muted text", { screen: true }],
      ["--dimmer", "--screen", T, "screen faint text", { screen: true }],
      ["--t-amber", "--screen", T, "screen amber text", { screen: true }],
      ["--t-red", "--screen", T, "screen red text", { screen: true }],
      ["#39d97c", "--screen", T, "screen ok text", { screen: true }],
      ["--focus", "--screen", U, "focus ring on screen", { screen: true }],
      ["#0b0d10", "--ch-servers", T, "channel scribble on servers", { screen: true }],
      ["#0b0d10", "--ch-internet", T, "channel scribble on internet", { screen: true }],
      ["#0b0d10", "--ch-wifi", T, "channel scribble on wifi", { screen: true }],
      ["#0b0d10", "--ch-switches", T, "channel scribble on switches", { screen: true }],
      ["#0b0d10", "--ch-dns", T, "channel scribble on dns", { screen: true }],
      ["#0b0d10", "--ch-services", T, "channel scribble on services", { screen: true }],
      ["#0b0d10", "--master-scribble", T, "master scribble"],
      ["#2b0000", "--led-r", T, "high-priority chip text"],
      ["--led-g", "--screen", U, "led: ok", { screen: true }],
      ["--led-r", "--screen", U, "led: alert", { screen: true }],
    ],
  },
];

// ---------------------------------------------------------------- run
const results = [];
for (const look of LOOKS) {
  const css = readFileSync(join(ROOT, look.file), "utf8");
  for (const scheme of ["light", "dark"]) {
    for (const [fg, bg, min, what, opt = {}] of look.pairs) {
      const tokens = tokenSet(css, scheme, Boolean(opt.screen));
      let worst = Infinity;
      let note = "";
      try {
        const under = colorsOf(tokens, opt.over ?? look.page);
        for (const b0 of colorsOf(tokens, bg)) {
          for (const u of under) {
            const b = b0.a < 1 ? over(b0, u) : b0;
            for (const f0 of colorsOf(tokens, fg)) {
              const f = f0.a < 1 ? over(f0, b) : f0;
              worst = Math.min(worst, ratio(f, b));
            }
          }
        }
      } catch (e) {
        note = e.message;
      }
      results.push({ look: look.id, scheme, fg, bg, what, min, ratio: worst, pass: note === "" && worst >= min, note });
    }
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 1));
} else {
  for (const r of results) {
    if (process.argv.includes("--all") || !r.pass) {
      console.log(
        `${r.pass ? "ok  " : "FAIL"} ${r.look.padEnd(14)} ${r.scheme.padEnd(5)} ${r.ratio.toFixed(2).padStart(5)} (need ${r.min})  ${r.fg} on ${r.bg}  ${r.what}${r.note ? "  [" + r.note + "]" : ""}`,
      );
    }
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length} pairs checked, ${failed} failing.`);
  process.exitCode = failed > 0 ? 1 : 0;
}
