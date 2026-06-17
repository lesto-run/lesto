# Security Policy

Keel takes security seriously. The framework ships hardening on by default — a
never-throw per-request boundary, scrypt password hashing that fails closed, dual
CSRF protection immune to the content-type-bypass CVE class, and an SSRF guard on
outbound webhooks — and we hold the reporting process to the same bar.

## Supported versions

Keel is pre-1.0. Until 1.0, security fixes land on the latest published `0.x`
minor only; there are no long-term-support branches yet.

| Version | Supported          |
| ------- | ------------------ |
| Latest `0.x` minor | ✅ |
| Older `0.x` minors | ❌ (upgrade to the latest `0.x`) |

When 1.0 ships, this table will be updated to name the supported major/minor
range.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a security
problem.** A public report tells an attacker about the hole before a fix is
available.

Instead, report privately through one of:

- **GitHub private vulnerability reporting** — on the repository's **Security**
  tab, choose **Report a vulnerability**. This opens a private advisory visible
  only to you and the maintainers. This is the preferred channel.
- **Email** — `security@keel.dev` with the details below. If you do not receive
  an acknowledgement within 3 business days, follow up through GitHub private
  reporting.

Include, as far as you can:

- the affected package(s) and version(s) (e.g. `@keel/auth@0.2.1`),
- a description of the vulnerability and its impact,
- a minimal reproduction or proof-of-concept,
- any known mitigations or workarounds.

## What to expect

- **Acknowledgement** within 3 business days.
- An **initial assessment** (severity + whether we can reproduce it) within 7
  business days.
- We will keep you updated as we work a fix, and we will coordinate a disclosure
  timeline with you. Our default target is a fix released within 90 days of a
  confirmed report; we will move faster for actively-exploited issues.
- With your consent, we will **credit you** in the release notes and the GitHub
  security advisory.

## Scope

In scope: any `@keel/*` package in this repository and the `create-keel`
scaffolder. The `examples/*` apps are demonstration code — report a security bug
in an example only if it reflects a flaw in the underlying framework package.

Thank you for helping keep Keel and its users safe.
