# Profiles Manager

Manages the list of Microsoft 365 tenant profiles a user has registered in the app and the currently active one. Each profile is backed by its own Electron session partition, so cookies, tokens, localStorage, IndexedDB, and service workers are fully isolated.

Design details and the decision trail are in [ADR-020](../../docs-site/docs/development/adr/020-multi-account-profile-switcher.md).

## Key Features

- **Profile CRUD**: `add`, `update`, `remove`, `list`, `get`
- **Active-profile tracking**: `setActive`, `getActive`, `getActiveId`
- **Legacy migration**: `bootstrapIfEmpty()` imports a pre-feature install as Profile 0 with no login loss
- **Stable partition identity**: each profile's partition string (`persist:teams-profile-{uuid}`) is generated once and never changes
- **IPC surface**: registers the nine `profile-*` channels consumed by the renderer switcher UI

## Persistence

Profiles live under two keys in the shared `settingsStore` (electron-store, `settings.json`):

- `app.profiles` — ordered array of profile records
- `app.profiles.active` — id of the currently active profile

User-facing `config.json` is **not** touched; profile management is entirely an in-app concern.

## Profile schema

```js
{
  id: string,              // uuid v4 (immutable)
  name: string,            // user-editable display name
  partition: string,       // "persist:teams-profile-{uuid}" or "persist:teams-4-linux" for Profile 0
  avatarColor: string,     // CSS color (hsl by default)
  avatarInitials: string,  // 2-char uppercase
  order: number,           // display order
  url: string | null,      // per-profile URL override (GovCloud / dev env)
  disableNotifications: boolean,
  muted: boolean,
  pinned: boolean
}
```

## Implementation

- `manager.js` — `ProfilesManager` class plus exported constants (`LEGACY_PARTITION`, `PROFILES_KEY`, `ACTIVE_KEY`)
- Electron is loaded lazily (inside `initialize()`) so the module is unit-testable under plain `node --test`
- Tests at `tests/unit/profilesManager.test.js`

Related files: [`app/partitions/manager.js`](../partitions/manager.js) (sibling, handles per-partition zoom), [`app/security/ipcValidator.js`](../security/ipcValidator.js) (IPC allowlist).
