/**
 * Hides the secrets in a stored switch configuration. A running-config carries SNMP community strings, local user and
 * enable hashes (crackable offline; type 7 is reversible on sight), RADIUS/TACACS keys, routing and NTP authentication
 * keys and pre-shared keys. Anyone with the Monitoring user tier (every volunteer, by default) may open a stored
 * configuration, so those lines are redacted for everyone who cannot change the switches (`monitors:write:any`). The
 * line stays, with its secret replaced, so a reader still sees WHAT is configured and a diff still shows a line that changed.
 *
 * It errs towards hiding: an over-redacted harmless token costs a reader a little context, a missed secret costs more.
 */
export const HIDDEN = "<hidden>";

/** After `keyword`, an optional encryption-type digit and then the secret; the secret is replaced. */
function hideAfter(line: string, keyword: RegExp): string {
  return line.replace(keyword, (_m, head: string, rest: string) => {
    const tokens = rest.split(/(\s+)/); // keeps the spacing
    let i = 0;
    while (i < tokens.length && tokens[i] === "") i++;
    // A single digit is the encryption type only when something follows it; a lone digit IS the secret.
    const next = tokens.slice(i + 2).some((t) => t.trim() !== "");
    if (/^\d$/.test(tokens[i] ?? "") && next) i += 2;
    if (i < tokens.length && tokens[i]) tokens[i] = HIDDEN;
    return head + tokens.join("");
  });
}

const RULES: Array<{ when: RegExp; keyword: RegExp }> = [
  // username bob privilege 15 secret 9 $9$..., username admin password 5 $5$... role network-admin
  { when: /^\s*username\s/i, keyword: /(^\s*username\s.*?\b(?:password|secret)\s+)(.*)$/i },
  // enable secret 9 $9$..., enable password level 5 7 0822...
  { when: /^\s*enable\s+(?:secret|password)\s/i, keyword: /(^\s*enable\s+(?:secret|password)\s+(?:level\s+\d+\s+)?)(.*)$/i },
  // snmp-server community NAME RO
  { when: /^\s*snmp-server\s+community\s/i, keyword: /(^\s*snmp-server\s+community\s+)(.*)$/i },
  // snmp-server host 10.1.1.1 [traps|informs] [version 2c [auth|priv|noauth]] COMMUNITY ...
  { when: /^\s*snmp-server\s+host\s/i, keyword: /(^\s*snmp-server\s+host\s+\S+\s+(?:(?:traps|informs)\s+)?(?:version\s+\S+\s+(?:(?:auth|priv|noauth)\s+)?)?)(.*)$/i },
  // line vty / line con:  password 7 0822455D0A16
  { when: /^\s*password\s/i, keyword: /(^\s*password\s+)(.*)$/i },
  // RADIUS / TACACS+ / server-private / IKE:  ... key 7 0822...
  { when: /\b(?:radius|tacacs|server-private|isakmp|aaa)\b.*\bkey\s/i, keyword: /(\bkey\s+)(.*)$/i },
  // key chains, HSRP/VRRP, wireless: key-string, wpa-psk, pre-shared-key
  { when: /\bkey-string\s/i, keyword: /(\bkey-string\s+)(.*)$/i },
  { when: /\bwpa-psk\s/i, keyword: /(\bwpa-psk\s+(?:ascii\s+|hex\s+)?)(.*)$/i },
  { when: /\bpre-shared-key\s/i, keyword: /(\bpre-shared-key\s+(?:local\s+|remote\s+)?)(.*)$/i },
  // ntp authentication-key 1 md5 SECRET, ip ospf message-digest-key 1 md5 7 SECRET, ip ospf authentication-key SECRET
  { when: /\b(?:authentication-key|message-digest-key)\s/i, keyword: /(\b(?:authentication-key|message-digest-key)\s+(?:\d+\s+(?:md5\s+)?)?)(.*)$/i },
];

/** snmp-server user NAME GROUP v3 auth md5 PASS priv aes 128 PASS (IOS) / ... auth md5 PASS priv PASS (NX-OS) */
function hideSnmpUser(line: string): string {
  return line
    .replace(/(\bauth\s+(?:md5|sha\S*)\s+)(\S+)/i, `$1${HIDDEN}`)
    .replace(/(\bpriv\s+(?:(?:aes|des|3des)\S*\s+(?:\d+\s+)?)?)(\S+)/i, `$1${HIDDEN}`);
}

export function redactConfig(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*snmp-server\s+user\s/i.test(line)) return hideSnmpUser(line);
      for (const rule of RULES) {
        if (rule.when.test(line)) return hideAfter(line, rule.keyword);
      }
      return line;
    })
    .join("\n");
}
