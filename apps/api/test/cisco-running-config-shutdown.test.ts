import { describe, expect, it } from "vitest";
import { parseRunningConfig } from "../src/cisco/parsers";

// `show run all` on NX-OS lists defaults too, so a port that IS shut down carries `shutdown` early and `no shutdown lan` (an
// unrelated setting) later. The latter used to be read as `no shutdown`.
const NXOS = `hostname Test-Nexus

interface Ethernet1/1
  description Server
  switchport
  switchport access vlan 100
  no shutdown lan
  no shutdown

interface Ethernet1/2
  no description
  shutdown
  switchport
  switchport access vlan 1
  no shutdown lan
  no switchport autostate exclude

interface Ethernet1/3
  shutdown lan
  switchport
`;

const IOS = `hostname Test-Ios
!
interface GigabitEthernet1/0/1
 description desk
 switchport access vlan 10
!
interface GigabitEthernet1/0/2
 shutdown
!
interface GigabitEthernet1/0/3
 shutdown
 no shutdown
!
`;

const by = (raw: string) => Object.fromEntries(parseRunningConfig(raw).ports.map((p) => [p.portId, p]));

describe("parseRunningConfig: shutdown", () => {
  it("keeps a shut NX-OS port shut when a later `no shutdown lan` line follows", () => {
    const p = by(NXOS);
    expect(p["Eth1/1"]!.adminEnabled).toBe(true);
    expect(p["Eth1/2"]!.adminEnabled).toBe(false);
  });

  it("does not take `shutdown lan` for a shutdown", () => {
    expect(by(NXOS)["Eth1/3"]!.adminEnabled).toBe(true);
  });

  it("reads IOS as before: a port is enabled unless it says shutdown, and the last word wins", () => {
    const p = by(IOS);
    expect(p["Gi1/0/1"]!.adminEnabled).toBe(true);
    expect(p["Gi1/0/2"]!.adminEnabled).toBe(false);
    expect(p["Gi1/0/3"]!.adminEnabled).toBe(true);
  });
});
