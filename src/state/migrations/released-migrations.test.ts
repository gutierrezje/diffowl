import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MIGRATION_001_INITIAL_SCHEMA } from "./001-initial-schema.js";
import { MIGRATION_002_BASE_REVIEW_TARGET } from "./002-base-review-target.js";
import { MIGRATION_003_POSSIBLE_DUPLICATES } from "./003-possible-duplicates.js";
import { MIGRATION_004_REVIEW_EXECUTIONS } from "./004-review-executions.js";
import { MIGRATION_005_REVIEW_INPUT_IDENTITY } from "./005-review-input-identity.js";
import { MIGRATION_006_REVIEW_OPERATIONS } from "./006-review-operations.js";

interface ReleasedMigration {
  version: number;
  releasedIn: string;
  sql: string;
  sha256: string;
}

const LATEST_RELEASED_SCHEMA_VERSION = 6;

// Once a migration ships, changing its SQL cannot update databases that already recorded the
// version. Fix released schemas with a new migration, then extend this list during the release.
const RELEASED_MIGRATIONS = [
  {
    version: 1,
    releasedIn: "0.4.0",
    sql: MIGRATION_001_INITIAL_SCHEMA,
    sha256: "18e135c4e81a64de264dee6a20b73305da662cd4e878163062efd94d62d99688",
  },
  {
    version: 2,
    releasedIn: "0.4.0",
    sql: MIGRATION_002_BASE_REVIEW_TARGET,
    sha256: "10984d5e675171a6676913553b17d415a77350504a34791df9c039994ef7ecdb",
  },
  {
    version: 3,
    releasedIn: "0.5.0",
    sql: MIGRATION_003_POSSIBLE_DUPLICATES,
    sha256: "b44ccd31b8dccc7988abc8374d7320725ec661fa8dacf6b2f8f388ab9c8e27d0",
  },
  {
    version: 4,
    releasedIn: "0.5.0",
    sql: MIGRATION_004_REVIEW_EXECUTIONS,
    sha256: "3e79e0b97441126baeabb37be76875b057f83a53e5d7e60ebdf877e0eb8fee38",
  },
  {
    version: 5,
    releasedIn: "0.5.0",
    sql: MIGRATION_005_REVIEW_INPUT_IDENTITY,
    sha256: "399ffce0fd517fe9889e083b92aa3777a4d0d7f27324c52db8a7aede09378f19",
  },
  {
    version: 6,
    releasedIn: "0.5.1",
    sql: MIGRATION_006_REVIEW_OPERATIONS,
    sha256: "5ae3eab94ec254846782dfcdf9c11300c7050c528e47d3fc0022bb701c58fdcd",
  },
] satisfies readonly ReleasedMigration[];

describe("released state migrations", () => {
  it("keeps every released migration byte-for-byte as published", () => {
    expect(RELEASED_MIGRATIONS.map(({ version }) => version)).toEqual(
      Array.from({ length: LATEST_RELEASED_SCHEMA_VERSION }, (_, index) => index + 1),
    );

    for (const migration of RELEASED_MIGRATIONS) {
      const sha256 = createHash("sha256").update(migration.sql).digest("hex");
      expect(sha256, `migration ${migration.version} shipped in ${migration.releasedIn}`).toBe(
        migration.sha256,
      );
    }
  });
});
