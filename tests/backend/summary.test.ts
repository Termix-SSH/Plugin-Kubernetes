import { afterEach, describe, expect, it } from "vitest";
import { mapLimit } from "../../src/backend/summary.js";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const summary = (id: number) => ({
  id,
  userId: "user-1",
  name: `host-${id}`,
  ip: `10.0.0.${id}`,
  port: 22,
  username: "root",
  tags: null,
  folder: null,
  authType: "password",
});

const NODES = JSON.stringify({
  items: [
    {
      metadata: { name: "node-1", creationTimestamp: "2026-10-01T00:00:00Z" },
      spec: {},
      status: { conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      metadata: { name: "node-2", creationTimestamp: "2026-10-01T00:00:00Z" },
      spec: {},
      status: { conditions: [{ type: "Ready", status: "False" }] },
    },
  ],
});

describe("GET /summary", () => {
  it("counts ready nodes and failing pods on enabled clusters", async () => {
    server = await startServer({ mock: { hosts: [summary(7), summary(8)] } });
    server.client.reply(/'get' 'nodes'/, { stdout: NODES });

    const res = await server.request("GET", "/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        hostId: 7,
        nodesReady: 1,
        nodesTotal: 2,
        podsRunning: 1,
        podsFailing: 1,
        podsTotal: 2,
      }),
    ]);

    const runs = server.commands().length;
    await server.request("GET", "/summary");
    expect(server.commands().length).toBe(runs);
  });

  it("needs kubernetes.use", async () => {
    server = await startServer({ permissions: [] });
    expect((await server.request("GET", "/summary")).status).toBe(403);
  });

  it("keeps to the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    expect(peak).toBe(2);
  });
});
