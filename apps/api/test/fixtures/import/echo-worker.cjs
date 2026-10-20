const { run } = require("./_protocol.cjs");
run(async (m, send, ask) => {
  const urls = [];
  for (let i = 1; i <= 3; i++) urls.push(await ask(i, `image-${i}.png`, "image/png", new Uint8Array(i * 1000)));
  send({ type: "done", markdown: `${m.kind}:${m.data.byteLength}:${urls.join(",")}` });
  setTimeout(() => process.exit(0), 20);
});
