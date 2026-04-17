# PRD — In-App Profile Switcher for teams-for-linux

> **Status:** Draft — awaiting upstream discussion / ADR approval before implementation.
> **Owner:** Johnathan Penberthy (HCS fork of IsmaelMartinez/teams-for-linux).
> **Target:** Feature PR to upstream `main`.

---

## 1. Problem

teams-for-linux currently supports only **one Microsoft 365 tenant per app instance**. To use more than one tenant, users must:

- Launch the AppImage multiple times with different `--user-data-dir` / `--class` / `--appIcon` flags, or
- Maintain custom `.desktop` entries and shell wrappers per tenant (documented at `docs-site/docs/multiple-instances.md`).

Consequences: separate tray icons per tenant, separate taskbar entries, manual setup for every new tenant, no cross-tenant notifications, and no parity with the official Microsoft Teams Windows client's in-app account switcher.

Community demand has been consistent for **7+ years** ([#72](https://github.com/IsmaelMartinez/teams-for-linux/issues/72), [#438](https://github.com/IsmaelMartinez/teams-for-linux/issues/438), [#1656](https://github.com/IsmaelMartinez/teams-for-linux/issues/1656), [#1830](https://github.com/IsmaelMartinez/teams-for-linux/issues/1830)). The upstream maintainer has stated he wants the BrowserView-in-single-window pattern but no contributor has delivered.

## 2. Goals

- G1. Let a user register ≥6 M365 tenants within one running app instance and switch between them from the UI without relaunching.
- G2. Fully isolate each tenant's cookies, tokens, localStorage, IndexedDB, and service workers (via Electron session partitions).
- G3. Preserve the single-window architecture affirmed in ADR-010 (single `BrowserWindow`, one tray icon, one instance lock).
- G4. Be merge-worthy upstream on the first serious PR: zero regressions for single-profile users, backwards-compatible config, and addresses every technical objection raised in ADR-010.
- G5. Match the official Microsoft Teams Windows client's account-switcher UX closely enough that users don't need a tutorial.

## 3. Non-goals

- NG1. Pop-out / floating chat windows for a single account. ADR-010 rejected this; out of scope.
- NG2. Concurrent live meetings in two tenants (Microsoft's own Windows client doesn't support this — one active call per app instance).
- NG3. Any new auth flow. We use the existing Teams web-app MSAL login per-partition; no changes to `app/login/`, `app/intune/`, or `app/browser/tools/tokenCache.js` semantics.
- NG4. Automatic tenant discovery. The user adds each tenant manually.
- NG5. Feature parity with Microsoft's MTO (multi-tenant organization) admin features — that's server-side.

## 4. Users & primary story

**Primary user:** a consultant / IT operator who logs into 3–10 M365 tenants during a working day (e.g., managed service providers, multi-org employees, freelancers with several clients).

**Core user story (MVP):**
> As a consultant with 6 M365 tenants, I want to add each tenant once in the Teams for Linux UI, see an avatar/initials chip for each in a switcher, click one to load that tenant's Teams view instantly, and receive notifications from every tenant regardless of which one is currently focused — all in one app window with one tray icon.

## 5. User stories

### MVP (Phase 1)
- U1. As a user, I open a "Profiles" menu and see all profiles I've added, with the active one marked.
- U2. As a user, I add a new profile by giving it a display name and (optionally) a color/initials for its avatar.
- U3. As a user, I click a profile in the switcher and the Teams view changes to that tenant within ~1 second; my other profile's session is kept warm in the background.
- U4. As a user, my first run after upgrade is identical to before — my existing `persist:teams-4-linux` session becomes "Profile 1" automatically, nothing is lost.
- U5. As a user, I can rename or delete a profile; deleting wipes that partition's storage.

### Phase 2 — Background notifications
- U6. As a user, I receive desktop notifications from non-focused profiles.
- U7. As a user, the tray/taskbar badge sums unread counts across all profiles.
- U8. As a user, the profile switcher shows a per-profile unread badge.

### Phase 3 — Power-user features
- U9. As a user, I can set a keyboard shortcut to cycle profiles.
- U10. As a user, I can pin up to 3 profiles to a persistent left rail (Windows Teams parity).
- U11. As a user, I can disable notifications or mute a specific profile.
- U12. As a user, I can launch with `--profile-id=<uuid>` from the command line to open a specific profile at startup.

### Deferred / v-next
- Hibernation / idle-discard of inactive profiles to reduce RAM (Ferdium-style).
- Cross-profile deep-link handling (opening a `msteams://` link in the correct profile based on tenant hint).

## 6. Out-of-scope scenarios (explicit)

- Joining two live meetings at once.
- Sharing drafts between tenants.
- Single-sign-on that pre-fills tokens from one tenant into another.
- Importing tenant lists from Azure AD / Entra.

## 7. Technical approach

### 7.1 Architecture

Adopt the **ElectronIM** pattern (Apache-2.0 reference implementation at `manusa/electronim`):

- **One `BrowserWindow`** hosting a top chrome region (switcher UI) + a content region.
- **One `WebContentsView` per profile**, all instantiated up front, added as children of `mainWindow.contentView`.
- Switching = toggle which `WebContentsView` is visible via `addChildView` / `removeChildView` and bounds updates. **No `loadURL` on switch** — sessions stay warm, drafts preserved, websocket stays connected.
- Each view bound to `session.fromPartition('persist:teams-profile-{uuid}', { cache: true })`.

### 7.2 Why not alternative patterns

| Option | Rejected because |
|--------|------------------|
| Multiple `BrowserWindow`s | Violates ADR-010; doubles tray/IPC/auth surface area. |
| `<webview>` tags (Ferdium/Rambox legacy) | Deprecated in Electron, less isolated than session partitions, more prone to notification-shim drift. |
| Recreate `BrowserWindow` on switch | Full Teams sign-in + websocket reconnect on every switch (5–10s); drafts lost; terrible UX. |
| Single `BrowserView` + reload per switch | Same as above plus deprecated API (`BrowserView` is replaced by `WebContentsView` in Electron 30+). |

### 7.3 Profile config schema

Stored in the existing `electron-store` `settingsStore` (not the user `config.json`, so existing `--user-data-dir` workflows are unaffected). Extends the existing `app.partitions` structure rather than replacing it.

```jsonc
{
  "app.profiles": [
    {
      "id": "3f29c1b8-…",              // uuid v4, never changes
      "name": "Handcrafted Solutions",  // user-editable display name
      "partition": "persist:teams-profile-3f29c1b8-…", // derived from id
      "avatarColor": "#0078D4",         // user-pickable hex
      "avatarInitials": "HC",           // auto-derived from name, user-editable
      "order": 0,                        // for sidebar ordering
      "url": "https://teams.microsoft.com/v2/", // per-profile override (GovCloud etc.)
      "disableNotifications": false,
      "muted": false,
      "pinned": false                    // Phase 3
    }
  ],
  "app.profiles.active": "3f29c1b8-…"   // current active profile id
}
```

### 7.4 Partition naming

- **Format:** `persist:teams-profile-{uuid-v4}`
- **Rules:** UUID is generated once at profile creation. Never derive from display name, tenant ID, or email — all are mutable and/or PII.
- **Migration:** On first launch after upgrade, if `app.profiles` is empty and the legacy `persist:teams-4-linux` has any cookies/localStorage, create Profile 0 pointing at that exact partition (preserving existing login). Name: "My account" (user can rename).

### 7.5 IPC channels to add (allowlist: `app/security/ipcValidator.js`)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `profile-list` | renderer → main, handle | Return the profile array + active id |
| `profile-get-active` | renderer → main, handle | Return just the active id |
| `profile-switch` | renderer → main, handle | Make a given profile id active |
| `profile-add` | renderer → main, handle | Create a new profile; returns new profile |
| `profile-update` | renderer → main, handle | Rename / recolor / reorder |
| `profile-remove` | renderer → main, handle | Remove profile + wipe its partition |
| `profile-changed` | main → renderer, send | Broadcast when the active profile changes |
| `profile-unread` | renderer → main, send | Per-profile unread count (Phase 2) |
| `profile-notification` | renderer → main, send | Forward `Notification` from inactive profile (Phase 2) |

Every channel gets a descriptive comment above registration and is documented via `npm run generate-ipc-docs`.

### 7.6 Single-instance lock behavior

The existing single-instance lock stays. `second-instance` args are parsed for a `--profile-id=<uuid>` flag or a `msteams://` deep link; if present, switch to that profile (or open the link in the best-matching profile) instead of re-focusing with no action.

### 7.7 Tray / badge / notifications

- **Phase 1:** Tray icon + badge reflect the **active** profile only. Tooltip shows profile name.
- **Phase 2:** A new `ProfileUnreadAggregator` module sums `profile-unread` events. Tray badge = sum. Each `WebContentsView` injects the existing `trayIconRenderer` / `mqttStatusMonitor` preload; the renderer tags every `unread-count` emission with its profile id. This requires **no changes** to `trayIconRenderer.js` itself beyond accepting an opaque id — the `modulesRequiringIpc` allowlist in `app/browser/preload.js` is preserved verbatim (addresses the #1902 gotcha flagged in upstream CLAUDE.md).
- **Notifications** from inactive profiles: inject a preload shim on each partition that forwards the `Notification` constructor call through `profile-notification` IPC with the profile id, so the main process can show a native Electron notification tagged with the correct profile name.

### 7.8 Migration & compatibility

- Existing users: zero action required. On first launch, their single session is imported as Profile 0 with the same underlying partition. All existing settings (`closeAppOnCross`, `customCSSName`, etc.) remain application-wide.
- Users launching multiple app instances with `--user-data-dir` continue to work. Each `--user-data-dir` holds its own `app.profiles` list independently. The two models compose.
- CLI flags (`--class`, `--appIcon`, `--url`, `--user-data-dir`) behave identically; new flag `--profile-id` is additive.

### 7.9 Known risks & mitigations

| Risk | Mitigation |
|------|------------|
| Teams PWA "blank white screen" on first load of a new tenant | On profile add, load the new view hidden and wait for `did-finish-load` + a readiness signal before exposing switcher entry. |
| Silent logouts of idle profiles | Accept in Phase 1; in Phase 2+, add periodic refresh on notification events. |
| Memory cost of N warm views | Measure on 6-tenant setup; if RSS > 2 GB, ship Ferdium-style hibernation in Phase 3. |
| 72 IPC channels assume one WebContents | Each profile view has its own preload; per-profile state is naturally scoped by `event.sender`. Audit shared state (e.g., `isFirstLoginTry` in `app/login/index.js:5`) and convert to a `Map<partition, state>`. |
| Screen-share preview hardcoded to `persist:teams-for-linux-session` (`app/mainAppWindow/index.js:138,157`) | Change to derive from the active profile's partition. Ensure no data bleed between profiles when starting a share. |
| E2E test suite | Extend `tests/e2e/authenticated/helpers.js` with a `setProfilesInStore()` helper; add a multi-profile smoke test per cross-distro configuration. |

## 8. UI design (MVP)

### 8.1 Switcher placement

**Top-right avatar dropdown**, overlaid on the Teams web UI via a small Electron-managed chrome region above the `WebContentsView`. Clicking opens a panel:

```
┌─────────────────────────────────────────┐
│ [HC] Handcrafted Solutions      ✓       │  ← active
│ [PF] Penberthy Family                    │
│ [PE] Penberthy Media                     │
│ [CA] CloudAccess Key                     │
│ [LS] Lab Software Solutions              │
│ [OT] Open Terrain Studios                │
│ ─────────────────────────────            │
│ ＋ Add profile…                          │
│ ⚙ Manage profiles…                       │
└─────────────────────────────────────────┘
```

Each row: colored circular avatar with initials, profile name, check if active, small unread badge (Phase 2).

**Rationale:** matches Microsoft's native Windows Teams client (research agent confirmed). Users won't need a tutorial.

### 8.2 "Manage profiles" window

A small modal `BrowserWindow` listing profiles with rename / recolor / delete / reorder affordances. Reuses the existing `app/documentationWindow` modal-window pattern.

### 8.3 Menu integration

Add a top-level **Profiles** menu to the application menu bar (`app/menus/appMenu.js`) mirroring the dropdown — dynamic submenu items driven by `app.profiles`. Pattern already established in the codebase for Quick Chat (`appMenu.js:16-24`) and Video (`appMenu.js:71-78`).

## 9. Phases

### Phase 0 — Upstream alignment (no code)
- 0.1. Open / reopen a GitHub issue citing #72, #438, #1656, #1830 — explicitly distinguishing from #1984/ADR-010.
- 0.2. Author `docs-site/docs/development/adr/020-multi-account-profile-switcher.md` following the ADR-010 template. Address every blocker ADR-010 raised.
- 0.3. Author `docs-site/docs/development/research/multi-account-profile-switcher-research.md` citing ElectronIM, Ferdium, Windows Teams UX sources (matches the maintainer's existing research-doc workflow).
- 0.4. Wait for @IsmaelMartinez sign-off before writing code.

### Phase 1 — MVP (code PR #1)
- 1.1. Extend `settingsStore` schema with `app.profiles` + `app.profiles.active`; reuse `PartitionsManager` as the store module.
- 1.2. First-run migration: import legacy `persist:teams-4-linux` as Profile 0.
- 1.3. Create `WebContentsView` per profile; wire `mainAppWindow/browserWindowManager.js` to host them.
- 1.4. Add IPC channels (§7.5) + allowlist entries + ipc-docs regeneration.
- 1.5. Switcher UI: top-right dropdown overlaying Teams chrome.
- 1.6. Profiles menu in menu bar.
- 1.7. Migrate shared state (`isFirstLoginTry`, screen-preview partition) to per-profile.
- 1.8. Single-instance-lock `--profile-id=<uuid>` flag parsing.
- 1.9. E2E test: `profile-switch-smoke.spec.js` exercising create → switch → delete.
- 1.10. Update `docs-site/docs/multiple-instances.md` with in-app flow, retain CLI flow as advanced option.

### Phase 2 — Background notifications (code PR #2)
- 2.1. Per-partition preload notification shim.
- 2.2. Per-partition unread-count tagging; aggregator in main.
- 2.3. Tray badge = sum; tooltip lists top-3 unread profiles.
- 2.4. Per-profile unread dots in switcher dropdown.
- 2.5. Per-profile `disableNotifications` + `muted` config plumbed through.

### Phase 3 — Power features (code PR #3)
- 3.1. `--profile-id` CLI flag end-to-end.
- 3.2. Keyboard shortcut to cycle profiles (integrate with `app/globalShortcuts/`).
- 3.3. Pinned-tenant sidebar (max 3, matches Windows).
- 3.4. Profile reordering via drag.

### Phase 4 — Optional polish (possibly not upstreamed)
- 4.1. Hibernation / idle-discard (Ferdium pattern) if memory complaints arise.
- 4.2. Per-profile `appIcon` / `customCSSName`.
- 4.3. Import/export profile list.

## 10. Success criteria

- **Functional:** 6 tenants registered; switching under 500ms; notifications arrive from inactive tenants (Phase 2); single tray icon; no regressions for single-profile users.
- **Upstream:** ADR-020 merged before any code PR. Every objection from ADR-010 has a written response in ADR-020. PR passes `npm run lint`, `npm run test:e2e`, and all 9 cross-distro configurations.
- **Quality:** Zero new PII in logs (per upstream CLAUDE.md). IPC docs regenerated. Module READMEs updated. No modifications to `trayIconRenderer` / `mqttStatusMonitor` preload allowlist (per upstream CLAUDE.md #1902 warning).
- **Maintainer acceptance:** PR merged without a "please use multiple-instances docs" close.

## 11. Open questions

- Q1. **Custom chrome vs OS-native title:** the switcher needs a region outside the Teams iframe. Does the maintainer prefer an Electron-drawn strip above the `WebContentsView`, or a hidden section within the existing frameless-window handling (`app/browser/tools/frameless.js`)? Surface in ADR-020.
- Q2. **First-run UX:** on upgrade, show a one-shot modal explaining the new Profiles menu, or silent migration + tooltip? Lean: silent migration.
- Q3. **Max profiles:** hard cap or just a soft recommendation? Microsoft's unofficial ceiling is ~10. Lean: no hard cap, but document 6–8 as the tested sweet spot.
- Q4. **`customUserDir` interaction:** does it still make sense to expose `customUserDir` when profiles exist? Lean: yes, as an independent axis (each `customUserDir` has its own profile list).
- Q5. **Handling `msteams://` deep links across profiles:** parse the tenant hint from the URL and activate the matching profile, or always open in the active profile? Lean: Phase 3 feature; Phase 1 uses active only.

## 12. References

- Upstream: [IsmaelMartinez/teams-for-linux](https://github.com/IsmaelMartinez/teams-for-linux)
- Related issues: [#72](https://github.com/IsmaelMartinez/teams-for-linux/issues/72), [#438](https://github.com/IsmaelMartinez/teams-for-linux/issues/438), [#689/#690 `customUserDir`](https://github.com/IsmaelMartinez/teams-for-linux/pull/690), [#1656](https://github.com/IsmaelMartinez/teams-for-linux/issues/1656), [#1830](https://github.com/IsmaelMartinez/teams-for-linux/issues/1830), [#1984 ADR-010](https://github.com/IsmaelMartinez/teams-for-linux/issues/1984)
- Prior art: [ElectronIM](https://github.com/manusa/electronim) (closest reference), [Ferdium](https://github.com/ferdium/ferdium-app), [Slack engineering blog — BrowserView migration](https://slack.engineering/growing-pains-migrating-slacks-desktop-app-to-browserview/)
- Microsoft: [Activity in other accounts and orgs](https://learn.microsoft.com/en-us/microsoftteams/activity-in-other-accounts-orgs), [Plan for multitenant organizations](https://learn.microsoft.com/en-us/microsoft-365/enterprise/plan-multi-tenant-org-overview), [Manage accounts and organizations in Teams](https://support.microsoft.com/en-us/office/manage-accounts-and-organizations-in-microsoft-teams-7b221128-6643-465c-a317-679e48cd2ce9)
- Electron APIs: [`session.fromPartition`](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options), [`WebContentsView`](https://www.electronjs.org/docs/latest/api/web-contents-view), [`BaseWindow`](https://www.electronjs.org/docs/latest/api/base-window)
