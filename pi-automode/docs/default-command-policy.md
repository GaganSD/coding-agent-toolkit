# Default command policy: deterministic allow / block / ask tiers

Derived from an investigation of [`r4vi/pi-auto-mode`](https://github.com/r4vi/pi-auto-mode)
(a pi re-implementation of Claude Code's auto mode), adapted to pi-automode's
architecture. pi-auto-mode uses regex bash patterns and a two-stage chat-model
classifier; pi-automode uses byte-exact rules, a verified read-only shell
subset, native protected-path checks, and a shadow-only native classifier.
This document is the **policy plan and benchmark seed source** — the "Current"
column is what the beta enforces today; the "Default v1" column is the proposed
shipping default. Nothing in "Default v1" is enforced until implemented and
tested.

## pi-auto-mode's structure (reference)

1. **Instant allow:** `read`, `grep`, `find`, `ls` tool calls, plus tool names
   imported from Claude Code settings (`permissions.allow`, `allowedTools`).
2. **Deterministic hard-deny** (regex on bash text; path checks on write/edit):
   shell profile modification (`~/.bashrc`, `~/.zshrc`, `~/.bash_profile`,
   `~/.profile`, `~/.bash_login`, `~/.bash_logout`), system profile
   (`/etc/profile`, `/etc/environment`, `/etc/bash.bashrc`), cron creation or
   mutation (`crontab -<x>`, `| crontab -`), TLS weakening (`npm config set
   strict-ssl false`, `git config … sslVerify false`, `curl|wget --insecure` /
   `--no-check-certificate`), `rm -rf` on system roots (`/bin /boot /dev /etc
   /lib* /media /mnt /opt /proc /run /sbin /srv /sys /tmp /usr /var`),
   `find <system-root> -delete`, SSH key injection (`> ~/.ssh/authorized_keys`),
   and self-modification of auto-mode's own config/extension files.
3. **Two-stage classifier** on everything else: cheap YES/NO filter, then a
   JSON decision, guided by 7 allow categories and 28 deny categories.

## Tier 0 — deterministic ALLOW (no dialog, no classifier)

| Rule | Current (beta) | Default v1 |
|---|---|---|
| Native `read`/`edit`/`write` on non-protected paths inside the workspace | Allow (workspace floor) | Keep |
| Native `read` of non-sensitive paths outside the workspace | Ask | Ask (keep — no silent out-of-workspace reads) |
| `grep`/`find`/`ls` tool calls (if the host exposes them) | Block (unsupported route) | Allow when the route is verified; until then keep Block |
| Byte-exact operator allowlist rule with complete evidence | Allow | Keep |
| **Default seed allowlist:** single invocations of the verified read-only set (`cat ls head tail wc file pwd echo printf whoami hostname uname basename dirname`, flags restricted per `src/core/shell.ts` PROVEN_SIMPLE, executable resolved under `/bin`, `/usr/bin`, `/sbin`, `/usr/sbin`, operands non-sensitive) | Only with an operator rule | Allow by default; each entry is still evidence-checked (trusted-prefix realpath, flag allowlist, no redirect/composition). `sort`, `date`, `diff`, `grep`, `tr`, `cut` stay excluded (write/exec/options). |

## Tier 1 — deterministic BLOCK (hard deny, no dialog, no classifier)

| Category | Current (beta) | Default v1 |
|---|---|---|
| Native write/edit to protected paths (Pi agent dir, package dir, project `.pi`, git metadata, CI config, secret/key names: `.env*`, `id_rsa*`, `*.pem`, …) | Block | Keep |
| Byte-exact operator blocklist rule (works even on incomplete evidence) | Block | Keep |
| Exposed unknown/custom/child/codemode/MCP tool routes while On | Block | Keep |
| Shell profile modification (bash redirect to `~/.bashrc` etc.; native write/edit to those paths) | Ask today (falls through) | **Block** — port pi-auto-mode's PROFILE_PATHS/SYSTEM_PROFILE_PATHS checks into the protected-path layer |
| System profile write (`/etc/profile`, `/etc/environment`, `/etc/bash.bashrc`) | Ask (outside workspace) | **Block** |
| Cron creation/mutation (`crontab -<x>`, `\| crontab -`) | Ask (opaque) | **Block** (byte/AST-level detection in the shell analyzer, not regex on raw text) |
| TLS/auth weakening (`npm config set strict-ssl false`, `git config sslVerify false`, `curl/wget --insecure`/`--no-check-certificate`) | Ask (opaque) | **Block** |
| Destructive delete of system roots (`rm -rf /etc …`, `find / -delete`) | Ask (unprovable target) | **Block** when the target provably resolves to a system root; unprovable stays Ask |
| SSH key injection (`> ~/.ssh/authorized_keys`, native write to it) | Ask (tilde) / Block if protected-name matched | **Block** — add `authorized_keys` to protected names |
| Self-modification (`automode.json`, `automode-logs.json`, the package dir) | Block (package dir is protected) | Keep; add the settings/log files by canonical path |

Design constraint carried from pi-automode: hard denies must be computed from
**analyzed evidence** (canonical paths, parsed shell structure), not regex on
raw command text — pi-auto-mode's regexes are the reference for *what* to
deny, not *how*.

## Tier 2 — ASK the operator (local dialog; Jev shadow metadata only)

Everything not in tier 0/1. Notable always-Ask families (conservative beta
limitations, explained rather than hidden):

- Opaque shell: interpreters (`python3 script.py`), package managers
  (`npm install`), git (all subcommands incl. `status`), compositions
  (`;`, `&&`, `|`, redirects), unresolvable executables, `~` operands
- Sensitive/protected **reads** (local Ask, never hosted for classifier)
- Unresolved message **block** rules (classifier can never clear)
- Message **allow** rules (never auto-approve in this beta)
- Network commands (`curl`, `wget`) — opaque, Ask

### What goes to Jev (shadow) vs. stays local

| Case | Sent to Jev? |
|---|---|
| Enabled message rule(s) exist AND evidence complete AND non-sensitive | Yes — metadata-only envelope (tool name, argument **key names**, path metadata, message-rule text) |
| No message rules / incomplete evidence / sensitive or protected target | No — decision stays fully local |
| Everything | Receipts are recorded in the decision log and **never** create Allow or clear a block |

### Semantic categories for the future calibrated gate (benchmark labels)

pi-auto-mode's 28 deny categories map to gold **unsafe** labels; its 7 allow
categories map to gold **safe** labels. They are reproduced as benchmark
scenario families in `benchmark/suite-v0.json` — they become enforcement
categories only after the launch-decision-3 evidence gates pass.
