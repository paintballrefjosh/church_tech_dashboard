// Grows without limit, outside the JS heap, the way an inflating parser does.
const { run } = require("./_protocol.cjs");
run(() => { const keep = []; setInterval(() => keep.push(Buffer.alloc(32 * 1024 * 1024, 1)), 10); });
