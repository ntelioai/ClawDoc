# Security Policy

## Supported versions

ClawDoc is at `0.1.x`. Only the latest released version receives security fixes; there are no LTS branches. Once `1.0.0` ships, this policy will be revisited.

| Version | Supported |
|---|---|
| Latest `0.1.x` | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.** Use one of these private channels:

1. **GitHub Security Advisories** (preferred) — go to the repo's [Security tab → Report a vulnerability](https://github.com/ntelioai/ClawDoc/security/advisories/new). This gives us a private collaboration thread tied to the repo.
2. **Email** — [security@ntelio.ai](mailto:security@ntelio.ai). PGP not required; if you want to encrypt, mention it in a short first message and we'll exchange keys.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The version of ClawDoc affected (release DMG, commit SHA if built from source).
- Your OS and any environment specifics that matter.

You should expect:

- An **acknowledgement within 3 business days**.
- An **initial assessment within 7 business days**.
- A target fix timeline based on severity — typically days for critical issues affecting users' local data or the embedded terminal, longer for low-impact issues.

## Scope

ClawDoc is a local-first desktop app. The interesting attack surface is:

- **The embedded HTTP server** (`serve.js`) — bound to `127.0.0.1`. Anything that lets a malicious local process or web page reach it in ways it shouldn't is in scope.
- **HTML/Markdown rendering** — we deliberately do not sanitize HTML inside Markdown (this is a single-user local tool reading your own files). Reports that rely on opening a hostile file you authored yourself are not in scope; reports that exploit the renderer through *normal* content workflows (e.g., a sandbox escape from a same-origin iframe affecting cross-doc state) are in scope.
- **The PTY bridge** — the `claude` terminal runs with your shell privileges. Any way to invoke commands through it without your interaction is in scope.
- **GitHub token storage** — stored at file mode `0600` in `settings.json`. Anything that leaks it elsewhere is in scope.
- **Auto-commit / push** — anything that causes commits or pushes you did not initiate is in scope.

Out of scope:

- Self-XSS in documents you authored.
- Anything requiring physical access or an already-compromised account.
- The fact that `xattr -dr com.apple.quarantine` is needed on unsigned macOS builds — this is a known shipping gap, tracked in [README.md](README.md#first-launch-on-macos) and [docs/PACKAGING.md](docs/PACKAGING.md).
- Vulnerabilities in upstream dependencies that we have no realistic mitigation for short of a version bump (we'll bump promptly when one ships).

## Disclosure

We follow coordinated disclosure. Once a fix is ready:

- A patch release goes out.
- A GitHub Security Advisory is published.
- The [CHANGELOG.md](CHANGELOG.md) gets a `Security` entry.
- Credit goes to the reporter unless they prefer to remain anonymous.

Thank you for taking the time to report responsibly.
