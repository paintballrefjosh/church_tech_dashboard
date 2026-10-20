import { describe, expect, it } from "vitest";
import { HIDDEN, redactConfig } from "../src/cisco/config-redact";

const redact = (line: string) => redactConfig(line);

describe("redactConfig", () => {
  it("hides local user and enable credentials of every kind, keeping the line", () => {
    expect(redact("username admin privilege 15 secret 9 $9$abcDEF$ghi")).toBe(`username admin privilege 15 secret 9 ${HIDDEN}`);
    expect(redact("username bob password 7 0822455D0A16")).toBe(`username bob password 7 ${HIDDEN}`);
    expect(redact("username ops password 5 $5$xyz role network-admin")).toBe(`username ops password 5 ${HIDDEN} role network-admin`);
    expect(redact("username plain password cleartext1")).toBe(`username plain password ${HIDDEN}`);
    expect(redact("enable secret 5 $1$abcd$efgh")).toBe(`enable secret 5 ${HIDDEN}`);
    expect(redact("enable password level 5 7 0822455D0A16")).toBe(`enable password level 5 7 ${HIDDEN}`);
    expect(redact("enable secret cleartext")).toBe(`enable secret ${HIDDEN}`);
  });

  it("hides SNMP communities and users", () => {
    expect(redact("snmp-server community Sup3rSecret RO")).toBe(`snmp-server community ${HIDDEN} RO`);
    expect(redact("snmp-server host 10.1.1.9 version 2c TrapString")).toBe(`snmp-server host 10.1.1.9 version 2c ${HIDDEN}`);
    expect(redact("snmp-server host 10.1.1.9 traps version 2c TrapString udp-port 162")).toBe(`snmp-server host 10.1.1.9 traps version 2c ${HIDDEN} udp-port 162`);
    expect(redact("snmp-server user mon grp v3 auth sha AuthPass123 priv aes 128 PrivPass456")).toBe(
      `snmp-server user mon grp v3 auth sha ${HIDDEN} priv aes 128 ${HIDDEN}`,
    );
  });

  it("hides line passwords, AAA and routing keys, key chains and pre-shared keys", () => {
    expect(redact(" password 7 094F471A1A0A")).toBe(` password 7 ${HIDDEN}`);
    expect(redact("tacacs-server host 10.0.0.5 key 7 0822455D0A16")).toBe(`tacacs-server host 10.0.0.5 key 7 ${HIDDEN}`);
    expect(redact("radius-server key 0 RadiusKey")).toBe(`radius-server key 0 ${HIDDEN}`);
    expect(redact(" server-private 10.0.0.6 key 7 0822455D0A16")).toBe(` server-private 10.0.0.6 key 7 ${HIDDEN}`);
    expect(redact("crypto isakmp key MyPsk address 1.2.3.4")).toBe(`crypto isakmp key ${HIDDEN} address 1.2.3.4`);
    expect(redact(" key-string 7 0822455D0A16")).toBe(` key-string 7 ${HIDDEN}`);
    expect(redact("ntp authentication-key 1 md5 NtpSecret")).toBe(`ntp authentication-key 1 md5 ${HIDDEN}`);
    expect(redact(" ip ospf message-digest-key 1 md5 7 0822455D0A16")).toBe(` ip ospf message-digest-key 1 md5 7 ${HIDDEN}`);
    expect(redact(" ip ospf authentication-key OspfKey")).toBe(` ip ospf authentication-key ${HIDDEN}`);
    expect(redact(" wpa-psk ascii 0 MyWifiKey")).toBe(` wpa-psk ascii 0 ${HIDDEN}`);
  });

  it("treats a lone digit as the secret itself, not as an encryption type", () => {
    expect(redact("enable password 1")).toBe(`enable password ${HIDDEN}`);
  });

  it("leaves ordinary configuration alone (so a reader and a diff still make sense)", () => {
    const config = [
      "hostname sw1",
      "interface GigabitEthernet1/0/1",
      " description uplink to core",
      " switchport trunk allowed vlan 10,20",
      " switchport mode trunk",
      "key chain KC",
      " key 1",
      "snmp-server location Basement rack 2",
      "snmp-server enable traps",
      "aaa authentication login default group tacacs+ local",
      "line vty 0 4",
      " login local",
      " transport input ssh",
      "ip ssh version 2",
      "end",
    ].join("\n");
    expect(redact(config)).toBe(config);
  });

  it("keeps every line (same count) so a diff's line numbers hold", () => {
    const config = "a\nusername x secret 5 abc\nb\nsnmp-server community c RO\nc";
    expect(redact(config).split("\n")).toHaveLength(5);
  });
});
