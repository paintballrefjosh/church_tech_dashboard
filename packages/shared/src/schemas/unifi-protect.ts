/**
 * UniFi Protect cameras, read from the Protect application's integration API on a UniFi OS console
 * (`/proxy/protect/integration/v1/cameras`, the same API key as the Network application). Read-only. Only while
 * `unifi.protect_enabled` is on: a self-hosted Network controller has no Protect.
 */
export interface UnifiCamera {
  id: string;
  name: string;
  /** Protect's word: CONNECTED, DISCONNECTED, CONNECTING ... */
  state: string;
  online: boolean;
  mac: string | null;
  model: string | null;
}

export interface UnifiCamerasReply {
  enabled: boolean;
  cameras: UnifiCamera[];
  /** Why they could not be read, when Protect is switched on but did not answer. */
  error: string | null;
}
