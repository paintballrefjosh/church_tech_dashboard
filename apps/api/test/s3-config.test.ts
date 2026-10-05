import { describe, expect, it } from "vitest";
import { describeS3, resolveS3Config } from "../src/attachments/s3.config";

const creds = { S3_ACCESS_KEY: "ak", S3_SECRET_KEY: "sk" };

describe("resolveS3Config", () => {
  it("keeps an existing MINIO_* .env working unchanged", () => {
    const c = resolveS3Config({
      MINIO_ENDPOINT: "minio:9000",
      MINIO_REGION: "us-east-1",
      MINIO_ROOT_USER: "churchadmin",
      MINIO_ROOT_PASSWORD: "pw",
      MINIO_BUCKET: "church-files",
      MINIO_USE_SSL: "false",
    });
    expect(c).toMatchObject({
      endPoint: "minio",
      port: 9000,
      useSSL: false,
      region: "us-east-1",
      bucket: "church-files",
      accessKey: "churchadmin",
      secretKey: "pw",
      pathStyle: true,
    });
  });

  it("defaults to the bundled store and bucket when only credentials are given", () => {
    const c = resolveS3Config(creds);
    expect(c).toMatchObject({ endPoint: "minio", port: 9000, useSSL: false, bucket: "church-files", region: "us-east-1" });
  });

  it("prefers the S3_* name over the MINIO_* one, setting by setting", () => {
    const c = resolveS3Config({
      S3_ENDPOINT: "s3.example.org:9000",
      MINIO_ENDPOINT: "minio:9000",
      S3_BUCKET: "new",
      MINIO_BUCKET: "old",
      S3_ACCESS_KEY: "new-ak",
      MINIO_ROOT_USER: "old-ak",
      S3_SECRET_KEY: "new-sk",
      MINIO_ROOT_PASSWORD: "old-sk",
    });
    expect(c).toMatchObject({ endPoint: "s3.example.org", port: 9000, bucket: "new", accessKey: "new-ak", secretKey: "new-sk" });
  });

  it("treats an empty S3_* value as unset and falls back", () => {
    const c = resolveS3Config({ S3_BUCKET: "  ", MINIO_BUCKET: "legacy", ...creds });
    expect(c.bucket).toBe("legacy");
  });

  describe("endpoint forms", () => {
    it("takes host:port", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "garage.lan:3900" })).toMatchObject({ endPoint: "garage.lan", port: 3900, useSSL: false });
    });
    it("takes a bare host (protocol's default port)", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "s3.example.org" })).toMatchObject({ endPoint: "s3.example.org", port: undefined, useSSL: false });
    });
    it("takes an https URL and turns TLS on from it", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "https://s3.eu-west-2.amazonaws.com" })).toMatchObject({
        endPoint: "s3.eu-west-2.amazonaws.com",
        port: undefined,
        useSSL: true,
      });
    });
    it("takes an http URL with a port", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "http://10.0.0.7:3900" })).toMatchObject({ endPoint: "10.0.0.7", port: 3900, useSSL: false });
    });
    it("takes an IPv6 address without the brackets", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "http://[fd00::5]:9000" })).toMatchObject({ endPoint: "fd00::5", port: 9000 });
    });
    it("accepts a trailing slash", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "https://s3.example.org/" })).toMatchObject({ endPoint: "s3.example.org", useSSL: true });
    });
    it("refuses a path, a query, and a non-http scheme", () => {
      expect(() => resolveS3Config({ ...creds, S3_ENDPOINT: "https://s3.example.org/bucket" })).toThrow(/without a path/);
      expect(() => resolveS3Config({ ...creds, S3_ENDPOINT: "https://s3.example.org/?x=1" })).toThrow(/without a path/);
      expect(() => resolveS3Config({ ...creds, S3_ENDPOINT: "ftp://s3.example.org" })).toThrow(/http/);
    });
  });

  describe("TLS flag", () => {
    it("S3_USE_SSL turns TLS on for a bare host:port", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "s3.example.org:443", S3_USE_SSL: "true" }).useSSL).toBe(true);
    });
    it("accepts 1/yes/on and 0/no/off", () => {
      expect(resolveS3Config({ ...creds, S3_USE_SSL: "1" }).useSSL).toBe(true);
      expect(resolveS3Config({ ...creds, S3_USE_SSL: "OFF" }).useSSL).toBe(false);
    });
    it("reads the old MINIO_USE_SSL", () => {
      expect(resolveS3Config({ ...creds, MINIO_USE_SSL: "true" }).useSSL).toBe(true);
    });
    it("agrees with the URL scheme or refuses a contradiction", () => {
      expect(resolveS3Config({ ...creds, S3_ENDPOINT: "https://x.example", S3_USE_SSL: "true" }).useSSL).toBe(true);
      expect(() => resolveS3Config({ ...creds, S3_ENDPOINT: "https://x.example", S3_USE_SSL: "false" })).toThrow(/contradicts/);
      expect(() => resolveS3Config({ ...creds, S3_ENDPOINT: "http://x.example", S3_USE_SSL: "true" })).toThrow(/contradicts/);
    });
    it("rejects a value that is not a boolean", () => {
      expect(() => resolveS3Config({ ...creds, S3_USE_SSL: "maybe" })).toThrow(/true or false/);
    });
  });

  describe("path style", () => {
    it("defaults to path-style addressing", () => {
      expect(resolveS3Config(creds).pathStyle).toBe(true);
    });
    it("can be switched to virtual-hosted", () => {
      expect(resolveS3Config({ ...creds, S3_PATH_STYLE: "false" }).pathStyle).toBe(false);
    });
  });

  it("carries a session token and region through", () => {
    const c = resolveS3Config({ ...creds, S3_SESSION_TOKEN: "tok", S3_REGION: "eu-west-2" });
    expect(c).toMatchObject({ sessionToken: "tok", region: "eu-west-2" });
  });

  it("refuses to run without credentials, naming both ways to give them", () => {
    expect(() => resolveS3Config({})).toThrow(/S3_ACCESS_KEY.*MINIO_ROOT_USER/);
    expect(() => resolveS3Config({ S3_ACCESS_KEY: "ak" })).toThrow(/S3_SECRET_KEY/);
  });
});

describe("describeS3", () => {
  it("describes the store without its keys", () => {
    const d = describeS3(resolveS3Config({ S3_ENDPOINT: "https://s3.example.org", S3_ACCESS_KEY: "AKIA123", S3_SECRET_KEY: "topsecret", S3_BUCKET: "b", S3_PATH_STYLE: "false" }));
    expect(d).toEqual({ endpoint: "https://s3.example.org", bucket: "b", region: "us-east-1", addressing: "virtual-hosted" });
    expect(JSON.stringify(d)).not.toMatch(/AKIA123|topsecret/);
  });
  it("shows a non-default port", () => {
    expect(describeS3(resolveS3Config({ S3_ENDPOINT: "garage:3900", ...creds })).endpoint).toBe("http://garage:3900");
  });
});
