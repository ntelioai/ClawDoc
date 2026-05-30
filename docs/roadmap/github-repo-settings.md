# GitHub repo settings

## Block publishing

- Enable **Discussions** (Settings → Features → Discussions). [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) points at it; if you'd rather not have Discussions, remove that contact link instead.

## Polish, after going public

- The **Private vulnerability reporting** toggle (org-level bulk control) is gated behind GitHub Advanced Security on paid Enterprise plans, so it isn't visible on the ntelioai free/team org. Not required — [`SECURITY.md`](../../SECURITY.md)'s advisory link works on any public repo without it; PVR just adds a visible "Report a vulnerability" button to the Security tab. After flipping public, check `https://github.com/ntelioai/ClawDoc/settings/security_analysis` — the per-repo toggle often appears there once visibility changes.
