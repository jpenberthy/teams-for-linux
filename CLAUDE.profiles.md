# CLAUDE.profiles.md — Feature Rules: Multi-Account Profile Switcher

> **Scope:** This file layers on top of the upstream `CLAUDE.md`. It applies **only** to work on the multi-account profile switcher feature. Read both files for any change touching profile/partition/session code.
> **Status:** Draft. Implementation begins on the `feat/multi-account-profiles` branch of the HCS fork.
> **Source of truth for design decisions:** `PRD.md` at repo root; `docs-site/docs/development/adr/020-multi-account-profile-switcher.md` once written.

---

## 1. Non-negotiables inherited from upstream

Before touching anything, re-read these sections of upstream `CLAUDE.md`:
- **§ Critical Module Initialization Requirements (#1902)** — do NOT remove `trayIconRenderer` or `mqttStatusMonitor` from the `modulesRequiringIpc` list in `app/browser/preload.js`. If the profile-scoping work looks like it needs changes there, stop and escalate.
- **§ Logging Guidelines — PII Protection** — profile names, tenant IDs, and email addresses are PII. Never log them at `info`+. Use opaque profile UUIDs in logs.
- **§ IPC Communication** — every new channel goes in the allowlist at `app/security/ipcValidator.js`, gets a descriptive comment above its registration, and triggers `npm run generate-ipc-docs`.
- **§ ADR-010** — the single-`BrowserWindow`, single-tray-icon, single-instance-lock invariants are load-bearing. This feature preserves all three. Any change that appears to violate them is a bug, not a feature.

## 2. Architectural invariants for this feature

- **One `BrowserWindow`.** The main window is still a single `BrowserWindow` (or `BaseWindow` if we migrate; decision in ADR-020). Multiple windows are out of scope.
- **One `WebContentsView` per profile.** Never reload the same view into a different partition — partitions are chosen at view creation and are immutable for the view's lifetime.
- **One tray icon.** The aggregated badge reflects all profiles; the active-profile name appears in the tooltip.
- **Profiles are additive.** Users with zero entries in `app.profiles` still see exactly the pre-feature behavior (bootstrap as Profile 0 from `persist:teams-4-linux`).
- **CLI compatibility.** `--user-data-dir`, `--class`, `--appIcon`, `--url`, `--customUserDir` keep working. The new `--profile-id` flag is additive.

## 3. Partition naming

- Format: `persist:teams-profile-{uuid-v4}` — no exceptions.
- `uuid` is generated with `crypto.randomUUID()` at profile creation and never changes.
- Do NOT derive the partition from:
  - display name (mutable, non-unique, PII)
  - tenant ID (mutable on B2B/guest swaps, PII)
  - email (PII)
- **Legacy migration partition:** the bootstrapped Profile 0 keeps the exact string `persist:teams-4-linux` — do not rename, or existing users lose their login.

## 4. Config schema conventions

- All profile config lives under the `app.profiles` key in the `electron-store` `settingsStore` (same store `PartitionsManager` already uses). It does NOT live in the user-facing `config.json`.
- Active profile id: `app.profiles.active`.
- New profile fields follow the upstream **"new features use nested config patterns from day one"** rule from the roadmap. Do not add flat top-level keys like `activeProfileId`.
- Every new field must have a default in `app/config/defaults.js` so missing-key reads don't throw.

## 5. IPC channel conventions

- Every channel is prefixed with `profile-`.
- Use `ipcMain.handle` for anything that returns data (`profile-list`, `profile-get-active`, `profile-add`, etc.).
- Use `ipcMain.on` only for fire-and-forget (`profile-unread`, `profile-notification` forward-from-shim).
- Broadcast state changes via `mainWindow.webContents.send('profile-changed', { activeId })`.
- Sender validation: when handling any profile-scoped IPC, resolve the profile from `event.sender` → `WebContentsView` → partition, not from a user-supplied id. Otherwise profile A's preload can spoof profile B.

## 6. Shared state to migrate (audit checklist)

These are module-level singletons today; making them per-profile is part of Phase 1:

| Location | Symptom if not migrated |
|----------|------------------------|
| `app/login/index.js:5` (`isFirstLoginTry`) | Switch profile mid-login → false "already logged in" state |
| `app/mainAppWindow/index.js:138,157` (screen-preview partition hardcoded `persist:teams-for-linux-session`) | Screen share preview leaks across profiles |
| `app/mainAppWindow/index.js` (`cleanExpiredAuthCookies` called once at startup) | Other profiles' expired cookies linger |
| Call state / power save blocker (`app/mainAppWindow/browserWindowManager.js:237-259`) | Blocker outlives the profile that started the call |
| Incoming call toast (`app/incomingCallToast/index.js`) | Toast from profile A dismissed by profile B |

Each one needs an entry in the ADR explaining how the migration preserves current behavior for single-profile users.

## 7. Test expectations

- **Unit tests** (`tests/unit/`): profile CRUD, partition-id derivation, migration of legacy partition to Profile 0.
- **E2E smoke** (`tests/e2e/`): launch with two pre-seeded profiles in temp `E2E_USER_DATA_DIR`; switch between them; verify `session.fromPartition(...).cookies.get({})` returns non-overlapping sets.
- **Cross-distro** (`tests/cross-distro/`): existing 9-configuration matrix must still pass. No new configs expected.
- Run `npm run lint` before every commit. Run `npm run test:e2e` before opening any PR.

## 8. Docs that MUST update on every PR touching this feature

- `docs-site/docs/multiple-instances.md` — shift emphasis from CLI flags to in-app flow; keep CLI section as "advanced".
- `docs-site/docs/configuration.md` — document `app.profiles` schema under the nested config section.
- `docs-site/docs/development/ipc-api-generated.md` — regenerated via `npm run generate-ipc-docs`.
- `app/partitions/README.md` (create if missing; upstream convention is module READMEs).
- `docs-site/docs/development/plan/roadmap.md` — move the feature from "in progress" to "shipped" on final PR.

## 9. PR submission discipline

- **No cold PRs.** ADR-020 must be merged first. See PRD.md § Phase 0.
- **One responsibility per PR.** PRD phases map to separate PRs: MVP, notifications, power features.
- **Every PR body includes `closes #<issue>`** per upstream CLAUDE.md (required for changelog generator).
- **Every PR references ElectronIM prior art** in its description so the maintainer can verify the pattern.
- **Single-profile regression check:** every PR description documents that the author launched the app with an empty `app.profiles` and confirmed the pre-feature behavior is byte-identical.

## 10. Red flags — stop and ask before proceeding

- Anything that needs a second `BrowserWindow` (the ADR-010 tripwire).
- Anything that touches the `modulesRequiringIpc` list.
- Auth/token cache changes in `app/browser/tools/tokenCache.js` or `app/intune/`.
- MQTT topic or payload schema changes.
- Electron API upgrades (the Electron 41 baseline is intentional; upgrading is its own separate effort per the roadmap).
- Any new dependency. Prefer adapting existing code / vendoring small helpers over adding `package.json` entries.

## 11. Branch / commit conventions (for the HCS fork)

- Work on branch `feat/multi-account-profiles` rebased regularly on `upstream/main`.
- Conventional commits: `feat(profiles): …`, `fix(profiles): …`, `docs(profiles): …`.
- Keep commits small and individually reviewable — the maintainer has stated he prefers this.
- Local-only files (`PRD.md`, this file) live at the fork root and are not included in the upstream PR. Add them to `.gitignore` or strip them when preparing the PR branch.
