import { describe, expect, it } from "vitest";
import { parsePoeDetail, parsePoeModules } from "../src/cisco/parsers";

// Captured from a Catalyst 3850 (names changed): the summary table, then `show power inline module 1 detail`, trimmed to three ports.
const OUTPUT = `House-Test-SW#show power inline

Module   Available     Used     Remaining
          (Watts)    (Watts)    (Watts) 
------   ---------   --------   ---------
1           790.0      143.7       646.3
Interface Admin  Oper       Power   Device              Class Max
                            (Watts)                            
--------- ------ ---------- ------- ------------------- ----- ----
Gi1/0/1   auto   off        0.0     n/a                 n/a   30.0 
Gi1/0/2   auto   on         15.4    Ieee PD             0     30.0 
House-Test-SW#show power inline module 1 detail

Module   Available     Used     Remaining
          (Watts)     (Watts)    (Watts) 
------   ---------   --------   ---------
1           790.0      143.7       646.3
 Interface: Gi1/0/1
 Inline Power Mode: auto
 Operational status: off
 Device Detected: no
 Device Type: n/a
 IEEE Class: n/a
 Discovery mechanism used/configured: Ieee and Cisco
 Police: off

 Power Allocated 
 Admin Value: 30.0
 Power drawn from the source: 0.0
 Power available to the device: 0.0
 
 Actual consumption
 Measured at the port: 0.0
 Maximum Power drawn by the device since powered on: 0.0
 
 Absent Counter: 0
 Over Current Counter: 0
 Short Current Counter: 0
 Invalid Signature Counter: 0
 Power Denied Counter: 0

 Power Negotiation Used: None
 LLDP Power Negotiation --Sent to PD--      --Rcvd from PD--
   Power Type:          -                    -
   Requested Power(W):  -                    -
   Allocated Power(W):  -                    -

Four-Pair PoE Supported: No
 Interface: Gi1/0/12
 Inline Power Mode: auto
 Operational status: on
 Device Detected: yes
 Device Type: Ieee PD
 IEEE Class: 4
 Discovery mechanism used/configured: Ieee and Cisco
 Police: off

 Power Allocated 
 Admin Value: 30.0
 Power drawn from the source: 25.5
 Power available to the device: 25.5
 
 Actual consumption
 Measured at the port: 8.0
 Maximum Power drawn by the device since powered on: 11.8
 
 Power Negotiation Used: LLDP-MED
 LLDP Power Negotiation --Sent to PD--      --Rcvd from PD--
   Power Type:          PSE                  PD
   Requested Power(W):  -                    25.5
 Interface: Gi1/0/37
 Inline Power Mode: never
 Operational status: off
 Device Detected: no
 Device Type: n/a
 IEEE Class: n/a
 Power Allocated 
 Admin Value: 30.0
 Power drawn from the source: 0.0
 Actual consumption
 Measured at the port: 0.0
House-Test-SW#`;

describe("parsePoeDetail", () => {
  const ports = parsePoeDetail(OUTPUT);
  const byId = new Map(ports.map((p) => [p.portId, p]));

  it("reads one entry per port, in order", () => {
    expect(ports.map((p) => p.portId)).toEqual(["Gi1/0/1", "Gi1/0/12", "Gi1/0/37"]);
  });

  it("reads a powered port: class, power set aside and power measured, in milliwatts", () => {
    expect(byId.get("Gi1/0/12")).toEqual({
      portId: "Gi1/0/12",
      status: "on",
      device: "Ieee PD",
      ieeeClass: 4,
      allocatedMw: 25500,
      measuredMw: 8000,
    });
  });

  it("reads an unused port as off with no device or class", () => {
    expect(byId.get("Gi1/0/1")).toEqual({ portId: "Gi1/0/1", status: "off", device: null, ieeeClass: null, allocatedMw: 0, measuredMw: 0 });
  });

  it("calls a port set to `power inline never` disabled, not just off", () => {
    expect(byId.get("Gi1/0/37")!.status).toBe("disabled");
  });

  it("reads the 3750-X's word for a port with PoE turned off", () => {
    const p = parsePoeDetail(" Interface: Gi1/0/37\n Inline Power Mode: off\n Operational status: off\n Device Type: n/a\n IEEE Class: n/a\n");
    expect(p[0]!.status).toBe("disabled");
  });

  it("keeps the device words a phone reports", () => {
    const p = parsePoeDetail(" Interface: Gi1/0/5\n Operational status: on\n Device Type: Cisco IP Phone 7960\n IEEE Class: 3\n Power drawn from the source: 12.9\n Measured at the port: 4.3\n");
    expect(p[0]).toMatchObject({ device: "Cisco IP Phone 7960", ieeeClass: 3, allocatedMw: 12900, measuredMw: 4300 });
  });

  it("leaves measured empty when the switch does not measure", () => {
    const p = parsePoeDetail(" Interface: Gi1/0/5\n Operational status: on\n Device Type: Ieee PD\n IEEE Class: 2\n Power drawn from the source: 7.0\n");
    expect(p[0]!.measuredMw).toBeNull();
  });

  it("gives nothing for a switch without PoE", () => {
    expect(parsePoeDetail("                         ^\n% Invalid input detected at '^' marker.\n")).toEqual([]);
    expect(parsePoeDetail("")).toEqual([]);
  });

  it("reads the blocks of several stack members and long-form names", () => {
    const p = parsePoeDetail(" Interface: GigabitEthernet2/0/3\n Operational status: on\n IEEE Class: 0\n");
    expect(p[0]!.portId).toBe("Gi2/0/3");
  });
});

describe("parsePoeModules", () => {
  it("lists the stack members that have PoE", () => {
    const raw = `Module   Available     Used     Remaining
          (Watts)     (Watts)    (Watts) 
------   ---------   --------   ---------
1           790.0      143.7       646.3
2           370.0       12.0       358.0
Interface Admin  Oper       Power   Device              Class Max
Gi1/0/1   auto   off        0.0     n/a                 n/a   30.0 `;
    expect(parsePoeModules(raw)).toEqual([1, 2]);
  });

  it("does not count a port row or count a member twice", () => {
    const raw = "1  90.0  56.3  33.7\nGi1/0/2   auto   on         15.4    Ieee PD             0     30.0 \n1  90.0  56.3  33.7\n";
    expect(parsePoeModules(raw)).toEqual([1]);
  });

  it("finds none on a switch without PoE", () => {
    expect(parsePoeModules("% Invalid input detected at '^' marker.")).toEqual([]);
  });
});
