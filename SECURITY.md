# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub:
**Security > Report a vulnerability** on this repository
(<https://github.com/paintballrefjosh/lampstand/security/advisories/new>).

Include what you found, how to reproduce it, and which version or commit you tested. You should
get a first answer within a week. Once a fix is released the advisory is published with credit,
unless you ask not to be named.

## Supported versions

Lampstand is released from the `master` branch; only the latest commit there receives security
fixes. Upgrade with `scripts/upgrade.sh` (see INSTALL.md, "Upgrading").

## Scope

In scope: the web app, the API, the probe worker, the installer and upgrade scripts, and the
signage agent that runs on Raspberry Pis. Out of scope: weaknesses that need an administrator
account to exploit by design (an administrator can already change everything), and third-party
systems Lampstand connects to (UniFi, Technitium, ProPresenter, Planning Center).
