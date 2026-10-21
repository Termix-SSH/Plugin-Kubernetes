import { describe, expect, it } from "vitest";
import { logFlags, parseLogOptions } from "../../src/backend/logs.js";
import {
  metricsUnavailable,
  parseCpu,
  parseMemory,
  parseTopContainers,
  parseTopNodes,
  parseTopPods,
} from "../../src/backend/metrics.js";
import {
  helmTime,
  parseHelmHistory,
  parseHelmList,
} from "../../src/backend/helm.js";
import { applyArgs, manifestOf } from "../../src/backend/manifests.js";
import { actionArgs, manualJobName } from "../../src/backend/routes.js";
import { diffPodStates } from "../../src/backend/services.js";
import { shellScript } from "../../src/backend/console.js";

describe("log options", () => {
  it("reads and checks the query", () => {
    expect(
      parseLogOptions({
        tail: "50",
        timestamps: "true",
        container: "web",
        since: "10m",
      }),
    ).toEqual({
      tail: 50,
      timestamps: true,
      previous: false,
      container: "web",
      since: "10m",
    });
    expect(parseLogOptions({ tail: "0" })).toBe("Tail must be from 1 to 10000");
    expect(parseLogOptions({ container: "a;b" })).toBe(
      "Invalid container name",
    );
    expect(parseLogOptions({ since: "1 day" })).toBe("Invalid since");
  });

  it("turns options into flags", () => {
    expect(
      logFlags({ tail: 10, timestamps: true, previous: true, since: "1h" }),
    ).toEqual(["--tail=10", "--timestamps", "--previous", "--since=1h"]);
  });
});

describe("metrics", () => {
  it("converts CPU and memory units", () => {
    expect(parseCpu("250m")).toBe(250);
    expect(parseCpu("2")).toBe(2000);
    expect(parseCpu("500000n")).toBe(0.5);
    expect(parseCpu("<unknown>")).toBeNull();
    expect(parseMemory("128Mi")).toBe(128 * 1024 * 1024);
    expect(parseMemory("1G")).toBe(1e9);
  });

  it("parses top output with and without namespaces", () => {
    expect(parseTopPods("kube-system  coredns-1  3m  12Mi\n", true)).toEqual([
      {
        namespace: "kube-system",
        name: "coredns-1",
        cpu: 3,
        memory: 12 * 1024 ** 2,
      },
    ]);
    expect(parseTopPods("web-1  10m  20Mi\n", false)).toEqual([
      { name: "web-1", cpu: 10, memory: 20 * 1024 ** 2 },
    ]);
    expect(parseTopNodes("node-1  250m  6%  1024Mi  13%\n")).toEqual([
      {
        name: "node-1",
        cpu: 250,
        cpuPercent: 6,
        memory: 1024 ** 3,
        memoryPercent: 13,
      },
    ]);
    expect(parseTopContainers("web-1  web  5m  30Mi\n")).toEqual([
      { name: "web", cpu: 5, memory: 30 * 1024 ** 2 },
    ]);
  });

  it("knows when metrics-server is missing", () => {
    expect(metricsUnavailable("error: Metrics API not available")).toBe(true);
    expect(metricsUnavailable("Unable to connect to the server")).toBe(false);
  });
});

describe("helm", () => {
  it("parses list and history", () => {
    const list = parseHelmList(
      JSON.stringify([
        {
          name: "traefik",
          namespace: "kube-system",
          revision: "3",
          updated: "x",
          status: "deployed",
          chart: "traefik-27.0.0",
          app_version: "v2.11",
        },
      ]),
    );
    expect(list).toEqual([
      {
        name: "traefik",
        namespace: "kube-system",
        revision: 3,
        updated: "x",
        status: "deployed",
        chart: "traefik-27.0.0",
        appVersion: "v2.11",
      },
    ]);
    expect(parseHelmList("")).toEqual([]);
    const history = parseHelmHistory(
      JSON.stringify([
        {
          revision: 1,
          status: "superseded",
          chart: "a-1",
          app_version: "1",
          description: "Install complete",
          updated: "x",
        },
        {
          revision: 2,
          status: "deployed",
          chart: "a-2",
          app_version: "2",
          description: "Upgrade complete",
          updated: "y",
        },
      ]),
    );
    expect(history.map((h) => h.revision)).toEqual([2, 1]);
  });
});

describe("helm times", () => {
  it("turns Go times into ISO and keeps ISO as is", () => {
    expect(helmTime("2026-10-21 19:13:21.683223962 +0000 UTC")).toBe(
      "2026-10-21T19:13:21.683Z",
    );
    expect(helmTime("2026-10-21 21:13:21 +0200 CEST")).toBe(
      "2026-10-21T19:13:21.000Z",
    );
    expect(helmTime("2026-10-21T19:13:21.008441033Z")).toBe(
      "2026-10-21T19:13:21.008441033Z",
    );
  });
});

describe("manifests", () => {
  it("needs YAML under 1 MB", () => {
    expect(manifestOf({})).toEqual({ error: "YAML is required" });
    expect(manifestOf({ yaml: "x".repeat(1024 * 1024 + 1) })).toEqual({
      error: "YAML is larger than 1 MB",
    });
    expect(manifestOf({ yaml: "kind: Pod" })).toBe("kind: Pod");
  });

  it("reads the manifest from stdin", () => {
    expect(applyArgs("apply", "web", true)).toEqual([
      "apply",
      "-f",
      "-",
      "-n",
      "web",
      "--dry-run=server",
      "-o",
      "name",
    ]);
    expect(applyArgs("replace", null, false)).toEqual([
      "replace",
      "-f",
      "-",
      "-o",
      "name",
    ]);
  });
});

describe("actions", () => {
  it("builds the kubectl arguments", () => {
    expect(
      actionArgs("deployments", "web", "prod", "scale", { replicas: 3 }),
    ).toEqual(["scale", "deployments.apps/web", "--replicas=3", "-n", "prod"]);
    expect(
      actionArgs("statefulsets", "db", "prod", "undo", { revision: 2 }),
    ).toEqual([
      "rollout",
      "undo",
      "statefulsets.apps/db",
      "--to-revision=2",
      "-n",
      "prod",
    ]);
    expect(actionArgs("cronjobs", "backup", "prod", "suspend", {})).toEqual([
      "patch",
      "cronjobs.batch/backup",
      "--type=merge",
      "-p",
      '{"spec":{"suspend":true}}',
      "-n",
      "prod",
    ]);
    expect(
      actionArgs("nodes", "n1", null, "drain", { deleteEmptyDirData: true }),
    ).toEqual([
      "drain",
      "n1",
      "--ignore-daemonsets",
      "--timeout=120s",
      "--delete-emptydir-data",
    ]);
  });

  it("refuses bad values and wrong kinds", () => {
    expect(
      actionArgs("deployments", "web", "prod", "scale", { replicas: -1 }),
    ).toMatch(/Replicas/);
    expect(
      actionArgs("deployments", "web", "prod", "scale", { replicas: "3; rm" }),
    ).toMatch(/Replicas/);
    expect(actionArgs("pods", "web", "prod", "scale", { replicas: 1 })).toMatch(
      /does not apply/,
    );
    expect(
      actionArgs("deployments", "web", "prod", "setImage", {
        container: "web",
        image: "x y",
      }),
    ).toBe("Invalid image");
    expect(
      actionArgs("deployments", "web", "prod", "setImage", {
        container: "Web!",
        image: "nginx",
      }),
    ).toBe("Invalid container name");
  });

  it("keeps a manual job name within 63 characters", () => {
    const name = manualJobName("a".repeat(52), 1_700_000_000_000);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^a+-manual-[a-z0-9]{6}$/);
  });
});

describe("pod events", () => {
  it("reports crash loops, restarts, starts and removals", () => {
    const before = new Map([
      ["default/a", { status: "Running", restarts: 0 }],
      ["default/b", { status: "Running", restarts: 1 }],
      ["default/c", { status: "Pending", restarts: 0 }],
      ["default/gone", { status: "Running", restarts: 0 }],
    ]);
    const after = new Map([
      ["default/a", { status: "CrashLoopBackOff", restarts: 2 }],
      ["default/b", { status: "Running", restarts: 2 }],
      ["default/c", { status: "Running", restarts: 0 }],
      ["default/new", { status: "Running", restarts: 0 }],
    ]);
    expect(diffPodStates(before, after)).toEqual([
      { namespace: "default", pod: "a", event: "crashloop" },
      { namespace: "default", pod: "b", event: "restarted" },
      { namespace: "default", pod: "c", event: "started" },
      { namespace: "default", pod: "new", event: "started" },
      { namespace: "default", pod: "gone", event: "removed" },
    ]);
  });
});

describe("console", () => {
  it("tries the requested shell first", () => {
    expect(shellScript("zsh")).toBe(
      'for s in zsh bash ash sh; do if command -v "$s" >/dev/null 2>&1; then exec "$s"; fi; done; exec sh',
    );
    expect(shellScript()).toContain("for s in bash ash sh;");
  });
});
