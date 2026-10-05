/* eslint-disable no-console */
/**
 * Copies every object from one S3-compatible bucket to another and proves the copy by
 * content. Run by scripts/s3-copy.sh inside the api image (which has the `minio` client and
 * the app's own S3 settings parser), not directly.
 *
 * An object is left alone when it is already at the destination with the same bytes. To
 * decide that cheaply: same size and an equal single-part ETag (an MD5) is taken as the
 * same; anything else of equal size is hashed (SHA-256) on both sides. Nothing is ever
 * deleted. After copying, every copied object is hashed at both ends.
 *
 * Environment: SRC_ENDPOINT SRC_ACCESS_KEY SRC_SECRET_KEY SRC_BUCKET [SRC_REGION SRC_PATH_STYLE]
 *              DST_... likewise; DRY_RUN=1 to only show the plan.
 */
const crypto = require("crypto");
const { Client } = require("minio");
const { resolveS3Config } = require("/app/dist/attachments/s3.config.js");

const CONCURRENCY = 4;

function open(prefix) {
  const e = process.env;
  const cfg = resolveS3Config({
    S3_ENDPOINT: e[`${prefix}_ENDPOINT`],
    S3_ACCESS_KEY: e[`${prefix}_ACCESS_KEY`],
    S3_SECRET_KEY: e[`${prefix}_SECRET_KEY`],
    S3_BUCKET: e[`${prefix}_BUCKET`],
    S3_REGION: e[`${prefix}_REGION`],
    S3_PATH_STYLE: e[`${prefix}_PATH_STYLE`],
  });
  const client = new Client({
    endPoint: cfg.endPoint,
    port: cfg.port,
    useSSL: cfg.useSSL,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region,
    pathStyle: cfg.pathStyle,
  });
  return { client, bucket: cfg.bucket, region: cfg.region };
}

function list({ client, bucket }) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    const stream = client.listObjectsV2(bucket, "", true);
    stream.on("data", (o) => o.name && out.set(o.name, { size: o.size, etag: (o.etag || "").replace(/"/g, "") }));
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });
}

async function sha256({ client, bucket }, key) {
  const stream = await client.getObject(bucket, key);
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    stream.on("data", (d) => h.update(d));
    stream.on("end", () => resolve(h.digest("hex")));
    stream.on("error", reject);
  });
}

/** Run `fn` over `items`, at most CONCURRENCY at a time. */
async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

(async () => {
  const src = open("SRC");
  const dst = open("DST");
  const dry = process.env.DRY_RUN === "1";
  console.log(`from: ${process.env.SRC_ENDPOINT}/${src.bucket}`);
  console.log(`to:   ${process.env.DST_ENDPOINT}/${dst.bucket}`);

  if (!(await src.client.bucketExists(src.bucket).catch(() => false))) {
    throw new Error(`cannot read the source bucket "${src.bucket}" (credentials or endpoint wrong?)`);
  }
  const dstExists = await dst.client.bucketExists(dst.bucket).catch(() => false);
  if (!dstExists && !dry) {
    await dst.client.makeBucket(dst.bucket, dst.region);
    console.log(`created the destination bucket ${dst.bucket}`);
  }

  const have = await list(src);
  const there = dstExists ? await list(dst) : new Map();
  const extra = [...there.keys()].filter((k) => !have.has(k)).length;

  // Plan: what has to be copied.
  const todo = [];
  let same = 0;
  const toHash = [];
  for (const [key, s] of have) {
    const d = there.get(key);
    if (!d) todo.push({ key, why: "missing" });
    else if (d.size !== s.size) todo.push({ key, why: "size differs" });
    else if (d.etag && d.etag === s.etag && !d.etag.includes("-")) same++;
    else toHash.push(key);
  }
  if (toHash.length) {
    const results = await pool(toHash, async (key) => [key, (await sha256(src, key)) === (await sha256(dst, key))]);
    for (const [key, equal] of results) {
      if (equal) same++;
      else todo.push({ key, why: "content differs" });
    }
  }

  console.log(`source: ${have.size} objects; destination: ${there.size}; already identical: ${same}; to copy: ${todo.length}${extra ? `; only at the destination (left alone): ${extra}` : ""}`);
  for (const t of todo.slice(0, 5)) console.log(`  ${t.why}: ${t.key}`);
  if (dry) {
    console.log("dry run: nothing was copied.");
    return;
  }

  let copied = 0;
  let bytes = 0;
  await pool(todo, async ({ key }) => {
    const st = await src.client.statObject(src.bucket, key);
    const body = await src.client.getObject(src.bucket, key);
    const meta = st.metaData && st.metaData["content-type"] ? { "Content-Type": st.metaData["content-type"] } : {};
    await dst.client.putObject(dst.bucket, key, body, st.size, meta);
    copied++;
    bytes += st.size;
  });
  if (todo.length) console.log(`copied ${copied} objects (${(bytes / 1048576).toFixed(2)} MiB)`);

  // Prove it: hash every object that was copied, at both ends.
  const bad = [];
  await pool(todo, async ({ key }) => {
    if ((await sha256(src, key)) !== (await sha256(dst, key))) bad.push(key);
  });
  if (bad.length) {
    console.error(`NOT IDENTICAL: ${bad.length} object(s) differ after copying:`);
    for (const k of bad.slice(0, 20)) console.error(`  ${k}`);
    process.exit(1);
  }
  console.log(todo.length ? `verified: all ${todo.length} copied objects have the same SHA-256 at both ends.` : "nothing to copy: the destination already matches.");
})().catch((e) => {
  console.error(`s3-copy: ${e.message}`);
  process.exit(1);
});
