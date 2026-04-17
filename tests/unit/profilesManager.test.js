"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");

const {
	ProfilesManager,
	LEGACY_PARTITION,
	PROFILES_KEY,
	ACTIVE_KEY,
} = require("../../app/profiles/manager");

function createStubStore(initial = {}) {
	const data = new Map(Object.entries(initial));
	return {
		get(key) {
			return data.get(key);
		},
		set(key, value) {
			data.set(key, value);
		},
		snapshot() {
			return Object.fromEntries(data);
		},
	};
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ProfilesManager - constructor", () => {
	it("throws without a store that implements get/set", () => {
		assert.throws(() => new ProfilesManager(), TypeError);
		assert.throws(() => new ProfilesManager({}), TypeError);
	});

	it("accepts a valid store", () => {
		const store = createStubStore();
		assert.doesNotThrow(() => new ProfilesManager(store));
	});
});

describe("ProfilesManager - bootstrapIfEmpty", () => {
	let store;
	let manager;
	beforeEach(() => {
		store = createStubStore();
		manager = new ProfilesManager(store);
	});

	it("creates a single profile pinned to the legacy partition on an empty store", () => {
		const profile = manager.bootstrapIfEmpty();
		assert.ok(profile, "bootstrap should return the new profile");
		assert.strictEqual(profile.partition, LEGACY_PARTITION);
		assert.strictEqual(profile.name, "My account");
		assert.match(profile.id, UUID_V4);
		assert.strictEqual(manager.list().length, 1);
		assert.strictEqual(manager.getActiveId(), profile.id);
	});

	it("is a no-op when profiles already exist", () => {
		manager.bootstrapIfEmpty();
		const second = manager.bootstrapIfEmpty();
		assert.strictEqual(second, null);
		assert.strictEqual(manager.list().length, 1);
	});

	it("never overwrites an existing app.profiles.active", () => {
		store.set(PROFILES_KEY, [
			{ id: "pre-existing", name: "Pre", partition: "persist:x" },
		]);
		store.set(ACTIVE_KEY, "pre-existing");
		const result = manager.bootstrapIfEmpty();
		assert.strictEqual(result, null);
		assert.strictEqual(manager.getActiveId(), "pre-existing");
	});
});

describe("ProfilesManager - add", () => {
	let store;
	let manager;
	beforeEach(() => {
		store = createStubStore();
		manager = new ProfilesManager(store);
	});

	it("allocates a unique UUID-scoped partition for each new profile", () => {
		const a = manager.add({ name: "Work" });
		const b = manager.add({ name: "Personal" });
		assert.notStrictEqual(a.id, b.id);
		assert.notStrictEqual(a.partition, b.partition);
		assert.match(a.partition, /^persist:teams-profile-[0-9a-f-]{36}$/);
		assert.match(b.partition, /^persist:teams-profile-[0-9a-f-]{36}$/);
	});

	it("derives avatarInitials from the name", () => {
		const p = manager.add({ name: "Handcrafted Solutions" });
		assert.strictEqual(p.avatarInitials, "HS");
	});

	it("derives a deterministic color from the profile id", () => {
		const p = manager.add({ name: "Work" });
		const expected = ProfilesManager.colorFromSeed(p.id);
		assert.strictEqual(p.avatarColor, expected);
	});

	it("sets the first profile as active automatically", () => {
		const p = manager.add({ name: "Work" });
		assert.strictEqual(manager.getActiveId(), p.id);
	});

	it("does not reassign active when adding subsequent profiles", () => {
		const a = manager.add({ name: "Work" });
		manager.add({ name: "Personal" });
		assert.strictEqual(manager.getActiveId(), a.id);
	});

	it("preserves caller-supplied avatarColor and avatarInitials", () => {
		const p = manager.add({
			name: "Work",
			avatarColor: "#FF0000",
			avatarInitials: "WK",
		});
		assert.strictEqual(p.avatarColor, "#FF0000");
		assert.strictEqual(p.avatarInitials, "WK");
	});

	it("rejects missing or non-string names", () => {
		assert.throws(() => manager.add(), /name is required/);
		assert.throws(() => manager.add({}), /name is required/);
		assert.throws(() => manager.add({ name: "   " }), /name is required/);
		assert.throws(() => manager.add({ name: 42 }), /name is required/);
	});

	it("increments order for each new profile", () => {
		const a = manager.add({ name: "A" });
		const b = manager.add({ name: "B" });
		const c = manager.add({ name: "C" });
		assert.strictEqual(a.order, 0);
		assert.strictEqual(b.order, 1);
		assert.strictEqual(c.order, 2);
	});

	it("trims whitespace from the name", () => {
		const p = manager.add({ name: "  Work  " });
		assert.strictEqual(p.name, "Work");
	});
});

describe("ProfilesManager - setActive", () => {
	let manager;
	beforeEach(() => {
		manager = new ProfilesManager(createStubStore());
		manager.add({ name: "A" });
		manager.add({ name: "B" });
	});

	it("switches the active profile", () => {
		const [a, b] = manager.list();
		assert.strictEqual(manager.getActiveId(), a.id);
		manager.setActive(b.id);
		assert.strictEqual(manager.getActiveId(), b.id);
	});

	it("throws when the profile does not exist", () => {
		assert.throws(() => manager.setActive("does-not-exist"), /not found/);
	});
});

describe("ProfilesManager - update", () => {
	let manager;
	let profile;
	beforeEach(() => {
		manager = new ProfilesManager(createStubStore());
		profile = manager.add({ name: "Work" });
	});

	it("renames a profile", () => {
		const updated = manager.update(profile.id, { name: "Consulting" });
		assert.strictEqual(updated.name, "Consulting");
	});

	it("re-derives avatarInitials when name changes without explicit initials", () => {
		const updated = manager.update(profile.id, { name: "Open Terrain" });
		assert.strictEqual(updated.avatarInitials, "OT");
	});

	it("respects explicit avatarInitials even when name changes", () => {
		const updated = manager.update(profile.id, {
			name: "Open Terrain",
			avatarInitials: "XX",
		});
		assert.strictEqual(updated.avatarInitials, "XX");
	});

	it("ignores non-editable fields", () => {
		manager.update(profile.id, {
			id: "hijacked",
			partition: "persist:evil",
		});
		const reloaded = manager.get(profile.id);
		assert.strictEqual(reloaded.id, profile.id);
		assert.strictEqual(reloaded.partition, profile.partition);
	});

	it("throws when the profile does not exist", () => {
		assert.throws(() => manager.update("nope", { name: "x" }), /not found/);
	});
});

describe("ProfilesManager - remove", () => {
	let manager;
	beforeEach(() => {
		manager = new ProfilesManager(createStubStore());
	});

	it("removes the profile from the list", () => {
		const a = manager.add({ name: "A" });
		const b = manager.add({ name: "B" });
		manager.remove(a.id);
		const remaining = manager.list();
		assert.strictEqual(remaining.length, 1);
		assert.strictEqual(remaining[0].id, b.id);
	});

	it("reassigns active when removing the active profile", () => {
		const a = manager.add({ name: "A" });
		const b = manager.add({ name: "B" });
		assert.strictEqual(manager.getActiveId(), a.id);
		manager.remove(a.id);
		assert.strictEqual(manager.getActiveId(), b.id);
	});

	it("clears active when the last profile is removed", () => {
		const a = manager.add({ name: "A" });
		manager.remove(a.id);
		assert.strictEqual(manager.getActiveId(), null);
	});

	it("leaves active alone when removing a non-active profile", () => {
		const a = manager.add({ name: "A" });
		const b = manager.add({ name: "B" });
		manager.remove(b.id);
		assert.strictEqual(manager.getActiveId(), a.id);
	});

	it("throws when the profile does not exist", () => {
		assert.throws(() => manager.remove("nope"), /not found/);
	});
});

describe("ProfilesManager - partitionFor", () => {
	it("returns the partition of the given profile", () => {
		const manager = new ProfilesManager(createStubStore());
		const p = manager.add({ name: "A" });
		assert.strictEqual(manager.partitionFor(p.id), p.partition);
	});

	it("returns null for an unknown id", () => {
		const manager = new ProfilesManager(createStubStore());
		assert.strictEqual(manager.partitionFor("missing"), null);
	});
});

describe("ProfilesManager.deriveInitials", () => {
	it("returns two-letter uppercase initials for a multi-word name", () => {
		assert.strictEqual(ProfilesManager.deriveInitials("Open Terrain"), "OT");
		assert.strictEqual(
			ProfilesManager.deriveInitials("Lab Software Solutions"),
			"LS",
		);
	});

	it("returns the first two letters for a single word", () => {
		assert.strictEqual(ProfilesManager.deriveInitials("handcrafted"), "HA");
	});

	it("normalizes whitespace", () => {
		assert.strictEqual(ProfilesManager.deriveInitials("  Open  Terrain  "), "OT");
	});

	it("returns ?? for empty or non-string inputs", () => {
		assert.strictEqual(ProfilesManager.deriveInitials(""), "??");
		assert.strictEqual(ProfilesManager.deriveInitials("   "), "??");
		assert.strictEqual(ProfilesManager.deriveInitials(null), "??");
		assert.strictEqual(ProfilesManager.deriveInitials(undefined), "??");
		assert.strictEqual(ProfilesManager.deriveInitials(42), "??");
	});
});

describe("ProfilesManager.colorFromSeed", () => {
	it("is deterministic for a given seed", () => {
		const a = ProfilesManager.colorFromSeed("same");
		const b = ProfilesManager.colorFromSeed("same");
		assert.strictEqual(a, b);
	});

	it("produces different colors for different seeds", () => {
		const a = ProfilesManager.colorFromSeed("first-seed");
		const b = ProfilesManager.colorFromSeed("different-seed");
		assert.notStrictEqual(a, b);
	});

	it("produces a well-formed hsl() string", () => {
		const c = ProfilesManager.colorFromSeed("any");
		assert.match(c, /^hsl\(\d{1,3}, 65%, 45%\)$/);
	});
});

describe("ProfilesManager - persistence keys", () => {
	it("writes under app.profiles and app.profiles.active", () => {
		const store = createStubStore();
		const manager = new ProfilesManager(store);
		manager.add({ name: "Work" });
		const snap = store.snapshot();
		assert.ok(Array.isArray(snap[PROFILES_KEY]));
		assert.ok(typeof snap[ACTIVE_KEY] === "string");
	});
});
