/**
 * Host liveness + name-resolution probes for the IPAM scanner. Deliberately
 * dependency-free:
 *
 *  - ICMP is done by spawning the system `ping` binary (busybox in the alpine
 *    runtime). Node has no raw-socket API, so this is the only in-process way to
 *    send an echo request; it needs CAP_NET_RAW on the api container (added in
 *    compose). If `ping` is missing or unprivileged the call just returns false
 *    and the caller falls back to TCP.
 *  - TCP liveness is a plain `net` connect sweep: a completed handshake OR a
 *    refusal (RST) both prove the host is up.
 *  - Names come from reverse DNS (`dns.reverse`) and NetBIOS nbstat (UDP/137),
 *    hand-rolled over `dgram`. (Bonjour/mDNS was removed: mDNS is link-local and
 *    this scanner runs off-subnet, so responders silently ignore its queries —
 *    the UniFi controller's client list supplies those friendly names instead.)
 */
import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { reverse as dnsReverse } from "node:dns/promises";
import { createSocket } from "node:dgram";

/** ICMP echo via the system `ping`. Resolves false on any failure. */
export function pingHost(ip: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const waitSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // busybox/iputils ping: -c count, -W per-reply timeout (seconds).
      child = spawn("ping", ["-c", "1", "-W", String(waitSec), ip], { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(false);
    }, timeoutMs + 750);
    child.on("error", () => {
      clearTimeout(killer);
      finish(false);
    });
    child.on("exit", (code) => {
      clearTimeout(killer);
      finish(code === 0);
    });
  });
}

/**
 * TCP connect sweep. A host is "up" if any port completes a handshake or is
 * actively refused (RST → something is listening on the stack). `openPorts`
 * lists ports that fully connected.
 */
export async function tcpProbe(
  ip: string,
  ports: number[],
  timeoutMs: number,
): Promise<{ up: boolean; openPorts: number[] }> {
  const openPorts: number[] = [];
  let up = false;
  await Promise.all(
    ports.map(
      (port) =>
        new Promise<void>((resolve) => {
          const sock = new Socket();
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve();
          };
          sock.setTimeout(timeoutMs);
          sock.once("connect", () => {
            up = true;
            openPorts.push(port);
            done();
          });
          sock.once("timeout", done);
          sock.once("error", (err: NodeJS.ErrnoException) => {
            // Refused means the host answered (up) but nothing is on that port.
            if (err.code === "ECONNREFUSED") up = true;
            done();
          });
          sock.connect(port, ip);
        }),
    ),
  );
  openPorts.sort((a, b) => a - b);
  return { up, openPorts };
}

/** Reverse DNS (PTR). Returns the first name, trailing dot stripped, or null. */
export async function reverseDns(ip: string): Promise<string | null> {
  try {
    const names = await dnsReverse(ip);
    const first = names[0]?.trim().replace(/\.$/, "");
    return first || null;
  } catch {
    return null;
  }
}

// ---- NetBIOS node status (nbstat) over UDP/137 ----

/** Encode a 16-byte NetBIOS name (level-1 encoding), padded/truncated. */
function encodeNetbiosName(name: string): Buffer {
  const raw = Buffer.alloc(16, 0x20); // space-padded
  raw.write(name.slice(0, 15), "ascii");
  raw[15] = 0x00; // suffix
  const out = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    const b = raw.readUInt8(i);
    out[i * 2] = 0x41 + (b >> 4);
    out[i * 2 + 1] = 0x41 + (b & 0x0f);
  }
  return out;
}

/**
 * NetBIOS node-status query for the wildcard name "*". Returns the first
 * non-group unique name (the workstation name), or null. Best-effort: any parse
 * failure or timeout yields null.
 */
export function netbiosName(ip: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const query = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x20]), // name length (32)
      encodeNetbiosName("*"),
      Buffer.from([0x00]), // name terminator
      Buffer.from([0x00, 0x21]), // type NBSTAT
      Buffer.from([0x00, 0x01]), // class IN
    ]);

    sock.on("error", () => finish(null));
    sock.on("message", (msg) => {
      clearTimeout(timer);
      finish(parseNbstat(msg));
    });
    sock.send(query, 137, ip, (err) => {
      if (err) {
        clearTimeout(timer);
        finish(null);
      }
    });
  });
}

/** Skip a DNS/NetBIOS name at `o` (length-prefixed labels or a compression
 * pointer) and return the offset of the byte after it. */
function skipName(msg: Buffer, o: number): number {
  while (o < msg.length) {
    const len = msg.readUInt8(o);
    if (len === 0) return o + 1; // root terminator
    if ((len & 0xc0) === 0xc0) return o + 2; // compression pointer (2 bytes)
    o += 1 + len;
  }
  return o;
}

function parseNbstat(msg: Buffer): string | null {
  try {
    if (msg.length < 12) return null;
    const qdcount = msg.readUInt16BE(4);
    const ancount = msg.readUInt16BE(6);
    if (ancount < 1) return null;

    // Responses vary by implementation: some echo the question section
    // (QDCOUNT>0), others answer with QDCOUNT=0 and the name inline in the RR.
    // Drive off the header counts rather than assuming a fixed layout.
    let o = 12;
    for (let i = 0; i < qdcount; i++) {
      o = skipName(msg, o);
      o += 4; // qtype + qclass
    }
    // First answer RR: name, then type(2) + class(2) + ttl(4) + rdlength(2).
    o = skipName(msg, o);
    o += 2 + 2 + 4 + 2;
    if (o >= msg.length) return null;

    const numNames = msg.readUInt8(o);
    o += 1;
    for (let i = 0; i < numNames; i++) {
      if (o + 18 > msg.length) break;
      const name = msg.toString("ascii", o, o + 15).replace(/\0/g, "").trim();
      const suffix = msg.readUInt8(o + 15);
      const flags = msg.readUInt16BE(o + 16);
      const isGroup = (flags & 0x8000) !== 0;
      o += 18; // 15-byte name + 1-byte suffix + 2-byte flags
      // Suffix 0x00 on a unique (non-group) name is the workstation name.
      if (!isGroup && suffix === 0x00 && name) return name;
    }
    return null;
  } catch {
    return null;
  }
}
