const { run } = require("./_protocol.cjs");
run((m, send) => { send({ type: "error", message: "not a zip file" }); setTimeout(() => process.exit(0), 20); });
