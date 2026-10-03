/**
 * Minimal ambient typings for net-snmp@3.x — covers only the surface the
 * Printers module uses. The upstream package ships JS only; rather than depend
 * on a possibly-stale @types/net-snmp, we declare what we need here.
 */
declare module "net-snmp" {
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;

  export interface SessionOptions {
    port?: number;
    version?: number;
    timeout?: number;
    retries?: number;
  }

  export interface VarBind {
    oid: string;
    value: unknown;
    type?: number;
  }

  export interface Session {
    subtree(
      oid: string,
      feedCb: (varbinds: VarBind[]) => void,
      doneCb: (error?: Error | null) => void,
    ): void;
    subtree(
      oid: string,
      maxRepetitions: number,
      feedCb: (varbinds: VarBind[]) => void,
      doneCb: (error?: Error | null) => void,
    ): void;
    get(oids: string[], cb: (error: Error | null, varbinds: VarBind[]) => void): void;
    close(): void;
  }

  export function createSession(host: string, community: string, options?: SessionOptions): Session;
}
