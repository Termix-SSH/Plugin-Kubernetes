import { afterEach, describe, expect, it } from "vitest";
import { clusterProblems } from "../../src/backend/summary.js";
import type { ResourceSummary } from "../../src/backend/resources.js";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
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

const item = (
  name: string,
  status: string,
  tone: ResourceSummary["tone"],
): ResourceSummary =>
  ({
    kind: "pods",
    name,
    namespace: "default",
    created: "",
    status,
    tone,
    fields: {},
  }) as ResourceSummary;

describe("clusterProblems", () => {
  it("lists nodes that are not ready and failing pods", () => {
    const problems = clusterProblems(
      [item("n1", "Ready", "ok"), item("n2", "NotReady", "error")],
      [item("ok", "Running", "ok"), item("bad", "CrashLoopBackOff", "error")],
    );
    expect(problems.map((p) => p.key)).toEqual([
      "node:n2",
      "pod:default/bad:CrashLoopBackOff",
    ]);
  });
});

describe("cluster alerts", () => {
  it("alerts once for a host that opted in", async () => {
    server = await startServer();
    server.client.reply(/'get' 'nodes'/, { stdout: NODES });
    await server.mock.ctx.settings.setHost(7, "alertProblems", true);
    await server.mock.ctx.kv.set("alerts:7", "user-1");

    await server.mock.runScheduled();
    await server.mock.runScheduled();

    const sent = server.mock.notifications.map((n) => n.notification);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({
      category: "kubernetes.cluster_problem",
      audience: { userId: "user-1" },
    });
    const keys = sent.map((n) => n.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("kubernetes.cluster_problem:7:node:node-2");
  });

  it("stays quiet when the host did not opt in", async () => {
    server = await startServer();
    server.client.reply(/'get' 'nodes'/, { stdout: NODES });
    await server.mock.ctx.kv.set("alerts:7", "user-1");
    await server.mock.runScheduled();
    expect(server.mock.notifications).toHaveLength(0);
  });
});
