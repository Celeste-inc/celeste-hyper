# Security Policy

## Supported Versions

Only the latest released version of celeste-hyper receives security fixes. There is no
long-term-support branch; upgrade to the latest release to pick up patches.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use [GitHub Security Advisories](https://github.com/Celeste-inc/celeste-hyper/security/advisories/new)
to report privately, or email security@celeste-inc.com.

Include:

- A description of the vulnerability and its impact.
- Steps to reproduce (PoC if possible).
- Affected version / commit.

We aim to acknowledge reports within 3 business days and to ship a fix or mitigation
within 30 days for confirmed high/critical issues.

## Scope

celeste-hyper embeds several security-sensitive surfaces (auth, RBAC, machine tokens,
webhook receivers, fleet enrollment, exec-over-websocket, kubeconfig handling). See
[`docs/architecture.md`](./docs/architecture.md) and [`docs/guardrails.md`](./docs/guardrails.md)
for the current threat model and invariants before reporting — some behaviors documented
there are intentional trade-offs, not bugs.

## Disclosure

We follow coordinated disclosure: once a fix is released, we credit the reporter (unless
they prefer to stay anonymous) in the release notes / advisory.
