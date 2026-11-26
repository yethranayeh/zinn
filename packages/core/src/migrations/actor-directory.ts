import type { Migration } from "./registry.js";

export const actorDirectoryMigration: Migration = {
  version: 8,
  name: "actor directory",
  rebuilds: [],
  apply(db) {
    db.exec("ALTER TABLE activity ADD COLUMN actor_directory TEXT");
  },
};
