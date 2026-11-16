import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunnerServer } from "../dist/server.js";

async function withServer(fn) {
  const server = createRunnerServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health check answers ok", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // Nothing but "ok": no version, no uptime, no word on what is running behind it.
    assert.deepEqual(body, { status: "ok" });
  });
});

test("anything else is a 404", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/anything`)).status, 404);
    assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 404);
  });
});
