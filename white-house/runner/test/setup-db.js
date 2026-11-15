// Run once before the tests: a fresh database, every migration, and one
// login role per White House role. The password is a test fixture.
import pg from "pg";
import { migrate } from "../dist/migrate.js";
import { TEST_DB, TEST_ROLE_PASSWORD, adminUrl } from "./helpers.js";

const server = new pg.Client({ connectionString: adminUrl("postgres") });
await server.connect();
await server.query(`drop database if exists ${TEST_DB} with (force)`);
await server.query(`create database ${TEST_DB}`);
await server.end();

const applied = await migrate({ connectionString: adminUrl() });
console.log(`setup-db: ${TEST_DB} created, ${applied.length} migrations applied`);

const admin = new pg.Client({ connectionString: adminUrl() });
await admin.connect();
for (const role of ["agent", "gateway", "ui"]) {
  await admin.query(`drop role if exists wh_test_${role}`);
  await admin.query(
    `create role wh_test_${role} login password '${TEST_ROLE_PASSWORD}' in role wh_${role}`,
  );
  await admin.query(`grant connect on database ${TEST_DB} to wh_test_${role}`);
}
await admin.end();
