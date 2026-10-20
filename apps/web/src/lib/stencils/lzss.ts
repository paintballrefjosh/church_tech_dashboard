/**
 * Visio's compression for the streams of a binary .vsd/.vss file: a 4096-byte ring with flag bytes (LZSS). A flag byte
 * covers eight items, lowest bit first; a set bit is one literal byte, a clear bit is a two-byte copy of 3 to 18 bytes
 * from the ring. The ring starts empty (zeros) and writing starts at position 0, so a copy's stored position is shifted
 * by 18 (it is relative to a ring that started at 4078).
 */
export function visioDecompress(src: Uint8Array, maxOut = 256 * 1024 * 1024): Uint8Array {
  // A copy gives at most 18 bytes for 2 input bytes, so the output cannot exceed 9 times the input plus a little.
  const out = new Uint8Array(Math.min(maxOut, src.length * 9 + 64));
  const ring = new Uint8Array(4096);
  let pos = 0;
  let o = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const flag = src[i++]!;
    for (let bit = 0; bit < 8 && i < n; bit++) {
      if (flag & (1 << bit)) {
        const b = src[i++]!;
        ring[pos & 4095] = b;
        if (o < out.length) out[o++] = b;
        pos++;
      } else {
        if (i + 1 >= n) {
          i = n;
          break;
        }
        const a1 = src[i]!;
        const a2 = src[i + 1]!;
        i += 2;
        const length = (a2 & 0x0f) + 3;
        let ptr = ((a2 & 0xf0) << 4) | a1;
        ptr = ptr > 4078 ? ptr - 4078 : ptr + 18;
        for (let j = 0; j < length; j++) {
          const b = ring[(ptr + j) & 4095]!;
          ring[(pos + j) & 4095] = b;
          if (o < out.length) out[o++] = b;
        }
        pos += length;
      }
    }
  }
  return out.subarray(0, o);
}
