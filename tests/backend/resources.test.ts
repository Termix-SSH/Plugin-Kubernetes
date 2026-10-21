import { describe, expect, it } from "vitest";
import {
  decodeSecret,
  parseItems,
  parseResourceList,
  parseRolloutHistory,
  podStatus,
  selectorLabels,
  summarize,
} from "../../src/backend/resources.js";
import { podJson } from "./server";

const list = (items: unknown[]) => JSON.stringify({ items });

describe("pods", () => {
  it("shows a waiting reason over the phase", () => {
    const pod = podJson("a", { waiting: "CrashLoopBackOff", restarts: 3 });
    expect(podStatus(pod)).toEqual({
      status: "CrashLoopBackOff",
      tone: "error",
    });
    const [row] = parseResourceList("pods", list([pod]));
    expect(row).toMatchObject({
      name: "a",
      namespace: "default",
      containers: ["web"],
      images: ["nginx:1.27"],
      fields: {
        ready: "0/1",
        restarts: 3,
        node: "node-1",
        owner: "ReplicaSet/web-abc",
      },
    });
  });

  it("marks a running pod ready or not", () => {
    expect(podStatus(podJson("a"))).toEqual({ status: "Running", tone: "ok" });
    const notReady = podJson("a");
    notReady.status.containerStatuses[0].ready = false;
    expect(podStatus(notReady).tone).toBe("warn");
  });

  it("shows Terminating and Completed", () => {
    const deleting = podJson("a") as ReturnType<typeof podJson> & {
      metadata: { deletionTimestamp?: string };
    };
    deleting.metadata.deletionTimestamp = "2026-10-01T00:00:00Z";
    expect(podStatus(deleting).status).toBe("Terminating");
    expect(podStatus(podJson("a", { phase: "Succeeded" }))).toEqual({
      status: "Completed",
      tone: "idle",
    });
  });
});

describe("workloads", () => {
  const deployment = (ready: number, replicas: number) => ({
    metadata: {
      name: "web",
      namespace: "prod",
      creationTimestamp: "2026-10-01T00:00:00Z",
    },
    spec: {
      replicas,
      selector: { matchLabels: { app: "web" } },
      template: {
        spec: { containers: [{ name: "web", image: "nginx:1.27" }] },
      },
    },
    status: {
      readyReplicas: ready,
      updatedReplicas: ready,
      availableReplicas: ready,
    },
  });

  it("reads readiness, images and replicas", () => {
    expect(summarize("deployments", deployment(3, 3))).toMatchObject({
      status: "Ready",
      tone: "ok",
      replicas: 3,
      containers: ["web"],
      fields: { ready: "3/3", images: "nginx:1.27", upToDate: 3, available: 3 },
    });
    expect(summarize("deployments", deployment(1, 3)).status).toBe("Updating");
    expect(summarize("deployments", deployment(0, 3)).tone).toBe("error");
    expect(summarize("deployments", deployment(0, 0)).status).toBe(
      "Scaled down",
    );
  });

  it("finds the selector of a workload and a service", () => {
    expect(selectorLabels("deployments", deployment(1, 1))).toEqual({
      app: "web",
    });
    expect(
      selectorLabels("services", { spec: { selector: { app: "web" } } }),
    ).toEqual({ app: "web" });
    expect(selectorLabels("services", { spec: {} })).toBeNull();
  });

  it("reads job and cronjob state", () => {
    const job = summarize("jobs", {
      metadata: { name: "j" },
      spec: { completions: 1 },
      status: {
        succeeded: 1,
        startTime: "2026-10-01T00:00:00Z",
        completionTime: "2026-10-01T00:01:30Z",
        conditions: [{ type: "Complete", status: "True" }],
      },
    });
    expect(job).toMatchObject({
      status: "Complete",
      fields: { completions: "1/1", duration: 90 },
    });
    const cron = summarize("cronjobs", {
      metadata: { name: "c" },
      spec: { schedule: "*/5 * * * *", suspend: true },
      status: {},
    });
    expect(cron).toMatchObject({
      status: "Suspended",
      suspended: true,
      fields: { schedule: "*/5 * * * *" },
    });
  });
});

describe("network, config and cluster", () => {
  it("shows a load balancer without an address as pending", () => {
    const row = summarize("services", {
      metadata: { name: "s" },
      spec: {
        type: "LoadBalancer",
        clusterIP: "10.43.0.1",
        ports: [{ port: 80, nodePort: 30080, protocol: "TCP" }],
      },
      status: { loadBalancer: {} },
    });
    expect(row).toMatchObject({
      status: "Pending",
      tone: "warn",
      fields: { ports: "80:30080/TCP" },
    });
  });

  it("lists secret keys without their values", () => {
    const row = summarize("secrets", {
      metadata: { name: "db" },
      type: "Opaque",
      data: { password: "aHVudGVyMg==" },
    });
    expect(row.keys).toEqual(["password"]);
    expect(JSON.stringify(row)).not.toContain("aHVudGVyMg==");
  });

  it("decodes secret values, keeping binary ones as base64", () => {
    expect(decodeSecret({ data: { password: "aHVudGVyMg==" } })).toEqual({
      password: "hunter2",
    });
    const binary = Buffer.from([0xff, 0xfe, 0x00]).toString("base64");
    expect(decodeSecret({ data: { blob: binary } })).toEqual({ blob: binary });
  });

  it("reads node roles, readiness and cordon state", () => {
    const row = summarize("nodes", {
      metadata: {
        name: "n1",
        labels: { "node-role.kubernetes.io/control-plane": "" },
      },
      spec: { unschedulable: true },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        nodeInfo: { kubeletVersion: "v1.31.1" },
        addresses: [{ type: "InternalIP", address: "192.168.1.10" }],
        capacity: { cpu: "4", memory: "8Gi" },
      },
    });
    expect(row).toMatchObject({
      status: "Ready, SchedulingDisabled",
      tone: "warn",
      unschedulable: true,
      fields: {
        roles: "control-plane",
        version: "v1.31.1",
        internalIP: "192.168.1.10",
      },
    });
    expect(row.namespace).toBeUndefined();
  });

  it("sorts events newest first", () => {
    const rows = parseResourceList(
      "events",
      list([
        {
          metadata: { name: "old" },
          type: "Normal",
          lastTimestamp: "2026-10-01T00:00:00Z",
          involvedObject: { kind: "Pod", name: "a" },
        },
        {
          metadata: { name: "new" },
          type: "Warning",
          lastTimestamp: "2026-10-02T00:00:00Z",
          reason: "BackOff",
          message: "x",
          count: 5,
          involvedObject: { kind: "Pod", name: "a" },
        },
      ]),
    );
    expect(rows.map((r) => r.name)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({
      tone: "warn",
      fields: { reason: "BackOff", object: "Pod/a", count: 5 },
    });
  });
});

describe("resources", () => {
  it("reads container limits and node capacity", () => {
    const pod = podJson("a");
    (pod.spec.containers[0] as Record<string, unknown>).resources = {
      limits: { cpu: "500m", memory: "64Mi" },
      requests: { cpu: "10m" },
    };
    expect(summarize("pods", pod).resources).toEqual([
      {
        name: "web",
        cpuLimit: 500,
        memoryLimit: 64 * 1024 * 1024,
        cpuRequest: 10,
        memoryRequest: null,
      },
    ]);
    const node = summarize("nodes", {
      metadata: { name: "n1" },
      status: { allocatable: { cpu: "2", memory: "2017456Ki" } },
    });
    expect(node.capacity).toEqual({ cpu: 2000, memory: 2017456 * 1024 });
  });
});

describe("parsing", () => {
  it("reads a single object as a one item list", () => {
    expect(parseItems('{"metadata":{"name":"a"}}')).toHaveLength(1);
    expect(parseItems('{"items":[]}')).toEqual([]);
  });

  it("parses rollout history newest first", () => {
    const output = `deployment.apps/web\nREVISION  CHANGE-CAUSE\n1         <none>\n2         kubectl set image\n`;
    expect(parseRolloutHistory(output)).toEqual([
      { revision: 2, changeCause: "kubectl set image" },
      { revision: 1, changeCause: null },
    ]);
  });
});
