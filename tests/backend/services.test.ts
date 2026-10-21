import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KubeEventsV1,
  KubePodEvent,
  KubeWorkloadsV1,
} from "../../src/backend/index.js";
import { podJson, startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

describe("kubernetes.workloads service", () => {
  it("lists pods and restarts and scales as the caller", async () => {
    server = await startServer();
    const kube = server.mock.services.get(
      "kubernetes.workloads",
    ) as KubeWorkloadsV1;
    const asUser = <T>(fn: () => Promise<T>) =>
      server!.mock.ctx.asUser("user-1", fn);

    const pods = await asUser(() => kube.listPods(7, { namespace: "default" }));
    expect(pods).toEqual([
      expect.objectContaining({
        name: "web-1",
        status: "Running",
        ready: "1/1",
      }),
      expect.objectContaining({
        name: "web-2",
        status: "CrashLoopBackOff",
        restarts: 4,
      }),
    ]);
    expect(server.mock.sshConnections.at(-1)).toMatchObject({
      host: 7,
      pool: "kubernetes",
    });

    await asUser(() => kube.restart(7, "deployments", "prod", "web"));
    expect(server.client.commands.at(-1)).toContain(
      "'rollout' 'restart' 'deployments.apps/web' '-n' 'prod'",
    );
    await asUser(() => kube.scale(7, "statefulsets", "prod", "db", 2));
    expect(server.client.commands.at(-1)).toContain(
      "'scale' 'statefulsets.apps/db' '--replicas=2' '-n' 'prod'",
    );

    await expect(
      asUser(() => kube.restart(7, "deployments", "prod", "web; rm -rf /")),
    ).rejects.toThrow(/Invalid/);
    await expect(
      asUser(() => kube.scale(7, "deployments", "prod", "web", -1)),
    ).rejects.toThrow(/Replicas/);
  });

  it("needs a calling user and respects read only", async () => {
    server = await startServer({ settings: { readOnly: true } });
    const kube = server.mock.services.get(
      "kubernetes.workloads",
    ) as KubeWorkloadsV1;
    await expect(kube.listPods(7)).rejects.toThrow(/calling user/);
    await expect(
      server.mock.ctx.asUser("user-1", () =>
        kube.restart(7, "deployments", "prod", "web"),
      ),
    ).rejects.toThrow(/read only/);
  });
});

describe("kubernetes.events service", () => {
  it("reports pod changes between polls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    server = await startServer();
    const events = server.mock.services.get(
      "kubernetes.events",
    ) as KubeEventsV1;
    const seen: KubePodEvent[] = [];
    const unsubscribe = await server.mock.ctx.asUser("user-1", () =>
      events.subscribe(7, (event) => seen.push(event)),
    );

    const poll = async (items: unknown[]) => {
      server!.client.reply(/'get' 'pods'/, {
        stdout: JSON.stringify({ items }),
      });
      vi.setSystemTime(Date.now() + 61_000);
      await server!.mock.runScheduled();
    };

    await poll([podJson("web-1")]);
    expect(seen).toEqual([]);
    await poll([podJson("web-1", { restarts: 1 })]);
    expect(seen).toEqual([
      { hostId: 7, namespace: "default", pod: "web-1", event: "restarted" },
    ]);
    await poll([]);
    expect(seen.at(-1)).toEqual({
      hostId: 7,
      namespace: "default",
      pod: "web-1",
      event: "removed",
    });

    unsubscribe();
    const count = seen.length;
    await poll([podJson("web-9")]);
    expect(seen).toHaveLength(count);
  });
});
