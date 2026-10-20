// Shared by the stand-in workers: wait for the "convert" message, then run `work(msg, send, replies)`.
exports.run = (work) => {
  const replies = new Map();
  process.on("message", (m) => {
    if (m.type === "image-url") return replies.get(m.id)?.(m.url);
    const send = (x) => process.send(x);
    const ask = (id, filename, mimetype, bytes) =>
      new Promise((resolve) => { replies.set(id, resolve); send({ type: "image", id, filename, mimetype, data: bytes }); });
    Promise.resolve(work(m, send, ask));
  });
};
