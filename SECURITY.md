# Security

SquillPad does not guarantee active security maintenance. It is a personal, intermittently
developed project; security reports may not receive an immediate response, and a fix or security
release is not guaranteed.

## Reporting a vulnerability

Please disclose vulnerabilities privately rather than opening a public issue when they involve
credentials, private notebook data, authentication, or remote access. Use GitHub's private
vulnerability reporting or Security Advisories for this repository if that feature is enabled.
Otherwise, contact the repository owner privately through the account hosting the repository.

Include the affected version or commit, impact, reproduction details, and any suggested mitigation.
Do not include passwords, access tokens, private notebook content, or other secrets in the report.
There is no response-time or remediation SLA.

## Security assumptions and limitations

- A project host binds to LAN-capable interfaces when a project is open. LAN sharing is enabled by
  default unless the project setting disables it; a host with no open project is loopback-only.
- Each host process generates separate local administrative and LAN invitation credentials.
  LAN URLs and QR codes allow profile registration, followed by ordinary profile sessions; they
  grant no administrative authority. Administrative controls require the host token and a loopback
  connection. Treat invitation links as credentials and keep them within the trusted network.
  The built-in server uses unencrypted HTTP; it does not provide TLS for notebook traffic or password login. Do not port-forward it to the public internet.
- Profile passwords are stored as salted scrypt hashes, while credentials and sessions are kept in
  the ignored `.squillpad-runtime/` directory. Non-secret profile preferences may be stored in
  `profiles/<username>.json` and can be included in GitHub snapshots; do not put secrets there.
- Logout, password reset, account removal, and session-limit eviction disconnect affected live
  collaboration sockets. Unrelated sessions remain connected.
- Browser offline state and connected clients may retain notebook data after a host is stopped or a
  profile is removed. Stopping the host does not revoke copies already downloaded to a device.
- GitHub synchronization is host-only. It relies on Git, SSH, HTTPS, or an operating-system
  credential manager configured by the host operator; SquillPad does not store GitHub tokens. GitHub
  synchronization is snapshot transport, not a distributed lock or a live collaboration service.
- The host includes request authentication, origin/path checks, and bounded payloads, but these are
  lightweight protections for self-hosting and trusted LAN use, not a public-internet or denial-of-
  service security boundary. Malicious local processes with filesystem access are outside the model.
