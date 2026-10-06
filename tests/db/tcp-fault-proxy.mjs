// A TCP forwarder that can misbehave on command, for tests/db/yb-failover.sh. One listener per target:
//   node tcp-fault-proxy.mjs <control-port> <listen-port>=<target-host>:<target-port> ...
// Modes, set per listener with  GET /mode?port=<listen-port>&mode=<mode>  on the control port:
//   pass        forward everything (default)
//   blackhole   a host that hangs or lost power: open connections go silent, new ones are accepted and
//               never answered
//   refuse      a host that is down: open connections are reset, new ones are refused
import http from "node:http";
import net from "node:net";

const [control, ...specs] = process.argv.slice(2);
const proxies = new Map();

function start(p) {
  p.server = net.createServer((client) => {
    p.sockets.add(client);
    client.on("close", () => p.sockets.delete(client));
    client.on("error", () => {});
    if (p.mode === "blackhole") return; // accepted and never answered
    const upstream = net.connect(p.target.port, p.target.host);
    p.sockets.add(upstream);
    upstream.on("close", () => p.sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("data", (d) => { if (p.mode === "pass") upstream.write(d); });
    upstream.on("data", (d) => { if (p.mode === "pass") client.write(d); });
  });
  p.server.listen(p.port, "0.0.0.0");
}

for (const spec of specs) {
  const [port, target] = spec.split("=");
  const [host, tport] = target.split(":");
  const p = { port: Number(port), target: { host, port: Number(tport) }, mode: "pass", sockets: new Set(), server: null };
  proxies.set(p.port, p);
  start(p);
}

function setMode(p, mode) {
  const before = p.mode;
  p.mode = mode;
  if (mode === "refuse") {
    for (const s of p.sockets) s.resetAndDestroy ? s.resetAndDestroy() : s.destroy();
    p.sockets.clear();
    p.server.close();
  } else if (before === "refuse") {
    start(p);
  } else if (mode === "pass" && before === "blackhole") {
    for (const s of p.sockets) s.destroy(); // whatever was hanging is gone now
    p.sockets.clear();
  }
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = proxies.get(Number(u.searchParams.get("port")));
  const mode = u.searchParams.get("mode");
  if (!p || !["pass", "blackhole", "refuse"].includes(mode)) { res.statusCode = 400; return res.end("bad request\n"); }
  setMode(p, mode);
  res.end(`${p.port} ${mode}\n`);
}).listen(Number(control), "0.0.0.0");
console.log("proxy ready");
