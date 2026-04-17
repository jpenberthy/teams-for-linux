"use strict";

const crypto = require("node:crypto");

const LEGACY_PARTITION = "persist:teams-4-linux";
const PROFILES_KEY = "app.profiles";
const ACTIVE_KEY = "app.profiles.active";

const EDITABLE_FIELDS = new Set([
  "name",
  "avatarColor",
  "avatarInitials",
  "url",
  "order",
  "disableNotifications",
  "muted",
  "pinned",
]);

class ProfilesManager {
  #settingsStore;
  #initialized = false;

  constructor(settingsStore) {
    if (!settingsStore || typeof settingsStore.get !== "function") {
      throw new TypeError("ProfilesManager requires a settingsStore with get/set");
    }
    this.#settingsStore = settingsStore;
  }

  bootstrapIfEmpty() {
    if (this.list().length > 0) {
      return null;
    }
    const profile = this.#buildProfile({
      name: "My account",
      partition: LEGACY_PARTITION,
    });
    this.#writeProfiles([profile]);
    this.#writeActive(profile.id);
    return profile;
  }

  list() {
    const raw = this.#settingsStore.get(PROFILES_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  getActiveId() {
    return this.#settingsStore.get(ACTIVE_KEY) || null;
  }

  getActive() {
    const id = this.getActiveId();
    return id ? this.get(id) : null;
  }

  setActive(id) {
    const profile = this.get(id);
    if (!profile) {
      throw new Error(`Profile not found: ${id}`);
    }
    this.#writeActive(id);
    return profile;
  }

  add({ name, avatarColor, avatarInitials, url } = {}) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Profile name is required");
    }
    const profiles = this.list();
    const profile = this.#buildProfile({
      name: name.trim(),
      avatarColor,
      avatarInitials,
      url,
    });
    profile.order = profiles.length;
    profiles.push(profile);
    this.#writeProfiles(profiles);
    if (!this.getActiveId()) {
      this.#writeActive(profile.id);
    }
    return profile;
  }

  update(id, changes = {}) {
    const profiles = this.list();
    const index = profiles.findIndex((p) => p.id === id);
    if (index < 0) {
      throw new Error(`Profile not found: ${id}`);
    }
    const filtered = {};
    for (const [key, value] of Object.entries(changes)) {
      if (EDITABLE_FIELDS.has(key)) {
        filtered[key] = value;
      }
    }
    const next = { ...profiles[index], ...filtered };
    if (filtered.name && !filtered.avatarInitials) {
      next.avatarInitials = ProfilesManager.deriveInitials(filtered.name);
    }
    profiles[index] = next;
    this.#writeProfiles(profiles);
    return next;
  }

  remove(id) {
    const profiles = this.list();
    const filtered = profiles.filter((p) => p.id !== id);
    if (filtered.length === profiles.length) {
      throw new Error(`Profile not found: ${id}`);
    }
    this.#writeProfiles(filtered);
    if (this.getActiveId() === id) {
      this.#writeActive(filtered[0]?.id ?? null);
    }
    return true;
  }

  partitionFor(id) {
    return this.get(id)?.partition ?? null;
  }

  initialize() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    const { ipcMain } = require("electron");

    // Return every profile plus the active profile id
    ipcMain.handle("profile-list", () => ({
      profiles: this.list(),
      activeId: this.getActiveId(),
    }));

    // Return just the active profile id
    ipcMain.handle("profile-get-active", () => this.getActiveId());

    // Make a profile active; caller shows the matching WebContentsView
    ipcMain.handle("profile-switch", (_event, { id } = {}) => this.setActive(id));

    // Create a profile; a new session partition is allocated
    ipcMain.handle("profile-add", (_event, input = {}) => this.add(input));

    // Rename / recolor / reorder; id plus partial-update object
    ipcMain.handle("profile-update", (_event, { id, changes } = {}) =>
      this.update(id, changes),
    );

    // Remove a profile; caller must wipe the partition's session data
    ipcMain.handle("profile-remove", (_event, { id } = {}) => this.remove(id));
  }

  static deriveInitials(name) {
    if (typeof name !== "string") {
      return "??";
    }
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return "??";
    }
    if (parts.length === 1) {
      return parts[0].substring(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  static colorFromSeed(seed) {
    const hash = crypto.createHash("sha1").update(String(seed)).digest("hex");
    const hue = parseInt(hash.substring(0, 6), 16) % 360;
    return `hsl(${hue}, 65%, 45%)`;
  }

  #buildProfile({ name, avatarColor, avatarInitials, url, partition }) {
    const id = crypto.randomUUID();
    return {
      id,
      name,
      partition: partition || `persist:teams-profile-${id}`,
      avatarColor: avatarColor || ProfilesManager.colorFromSeed(id),
      avatarInitials: avatarInitials || ProfilesManager.deriveInitials(name),
      order: 0,
      url: url || null,
      disableNotifications: false,
      muted: false,
      pinned: false,
    };
  }

  #writeProfiles(profiles) {
    this.#settingsStore.set(PROFILES_KEY, profiles);
  }

  #writeActive(id) {
    this.#settingsStore.set(ACTIVE_KEY, id);
  }
}

module.exports = {
  ProfilesManager,
  LEGACY_PARTITION,
  PROFILES_KEY,
  ACTIVE_KEY,
};
