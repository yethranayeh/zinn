import type { Migration } from "./registry.js";

export const actorClientMigration: Migration = {
  version: 4,
  name: "actor client",
  rebuilds: [],
  apply(db) {
    db.exec("ALTER TABLE activity ADD COLUMN actor_client TEXT");
  },
};
