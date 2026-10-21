import { describe, expect, it } from "vitest";
import { parseInterfacesStatus } from "../src/cisco/parsers";

// Captured from a Nexus 3000 (names changed): empty SFP cages say xcvrAbsen, a port-channel with no member says noOperMem, and the
// management port and the SVIs have their own sections.
const NXOS = `NP-Test-Switch# show interface status

--------------------------------------------------------------------------------
Port          Name               Status    Vlan      Duplex  Speed   Type
--------------------------------------------------------------------------------
mgmt0         --                 notconnec routed    auto    auto    --         

--------------------------------------------------------------------------------
Port          Name               Status    Vlan      Duplex  Speed   Type
--------------------------------------------------------------------------------
Eth1/1        proxmox1.example.o connected trunk     full    10G     SFP-H10GB-CU1M
Eth1/2        --                 xcvrAbsen trunk     auto    auto    --         
Eth1/3        Nutanix-IPMI       connected 100       full    1000    1000base-T 
Eth1/4        uplink to switch 8 disabled  1         auto    auto    --         
Eth1/5        --                 err-disab 1         auto    auto    --         
Eth1/6        --                 linkFlapE 1         auto    auto    --         

--------------------------------------------------------------------------------
Port          Name               Status    Vlan      Duplex  Speed   Type
--------------------------------------------------------------------------------
Po51          --                 connected trunk     full    10G     --         
Po54          --                 noOperMem trunk     auto    auto    --         

--------------------------------------------------------------------------------
Port          Name               Status    Vlan      Duplex  Speed   Type
--------------------------------------------------------------------------------
Vlan1         --                 down      routed    auto    auto    --
Vlan320       --                 connected routed    auto    auto    --
NP-Test-Switch# show running-config
interface Ethernet1/1
  description proxmox1
Eth1/9        --                 connected 1         full    10G     --
`;

const IOS = `Switch#show interfaces status

Port      Name               Status       Vlan       Duplex  Speed Type
Gi1/0/1   front desk         connected    10         a-full a-1000 10/100/1000BaseTX
Gi1/0/2                      notconnect   10           auto   auto 10/100/1000BaseTX
Gi1/0/3   spare              disabled     1            auto   auto 10/100/1000BaseTX
Gi1/0/4                      err-disabled 1            auto   auto 10/100/1000BaseTX
Te1/1/1                      notconnect   1            auto   auto Not Present
Gi1/0/5   uplink             connected    trunk      a-full a-1000 10/100/1000BaseTX
Switch#
`;

const by = (rows: ReturnType<typeof parseInterfacesStatus>) => Object.fromEntries(rows.map((r) => [r.portId, r]));

describe("parseInterfacesStatus", () => {
  it("reads every status word a Nexus uses, not just the ones it was taught", () => {
    const p = by(parseInterfacesStatus(NXOS));
    expect(p["Eth1/1"]!.operStatus).toBe("up");
    expect(p["Eth1/2"]!.operStatus).toBe("notconnect"); // xcvrAbsen: no transceiver, so no link
    expect(p["Eth1/3"]!.operStatus).toBe("up");
    expect(p["Eth1/4"]!.operStatus).toBe("down"); // disabled
    expect(p["Eth1/5"]!.operStatus).toBe("err-disabled");
    expect(p["Eth1/6"]!.operStatus).toBe("err-disabled"); // link flap
    expect(p.Po51!.operStatus).toBe("up");
    expect(p.Po54!.operStatus).toBe("notconnect"); // noOperMem
  });

  it("keeps a name with spaces out of the status and takes the VLAN column", () => {
    const p = by(parseInterfacesStatus(NXOS));
    expect(p["Eth1/4"]!.operStatus).toBe("down");
    expect(p["Eth1/1"]!.mode).toBe("trunk");
    expect(p["Eth1/3"]!.accessVlan).toBe(100);
    expect(p["Eth1/3"]!.mode).toBe("access");
  });

  it("leaves SVIs alone and does not read the configuration that follows", () => {
    const p = by(parseInterfacesStatus(NXOS));
    expect(p.Vlan1).toBeUndefined();
    expect(p.Vlan320).toBeUndefined();
    expect(p["Eth1/9"]).toBeUndefined();
  });

  it("still reads an IOS table, a blank name included", () => {
    const rows = parseInterfacesStatus(IOS);
    const p = by(rows);
    expect(rows).toHaveLength(6);
    expect(p["Gi1/0/1"]!.operStatus).toBe("up");
    expect(p["Gi1/0/2"]!.operStatus).toBe("notconnect");
    expect(p["Gi1/0/3"]!.operStatus).toBe("down");
    expect(p["Gi1/0/4"]!.operStatus).toBe("err-disabled");
    expect(p["Te1/1/1"]!.operStatus).toBe("notconnect");
    expect(p["Gi1/0/5"]!.mode).toBe("trunk");
  });

  it("falls back to the known words for output with no header", () => {
    const p = by(parseInterfacesStatus("Gi1/0/1   desk   connected   10   a-full a-1000 10/100/1000BaseTX\nGi1/0/2   x   notconnect   1   auto auto -"));
    expect(p["Gi1/0/1"]!.operStatus).toBe("up");
    expect(p["Gi1/0/2"]!.operStatus).toBe("notconnect");
  });
});
