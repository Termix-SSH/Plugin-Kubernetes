import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  COLUMNS,
  SECTIONS,
  age,
  detailTabs,
  duration,
  formatBytes,
  formatCpu,
  supports,
  toneFilter,
} from "../../src/frontend/kinds";
import {
  pushSample,
  usageBase,
} from "../../src/frontend/components/PodMetrics";
import { helmTone } from "../../src/frontend/components/HelmView";
import { ACTION_KINDS as BACKEND_ACTION_KINDS } from "../../src/backend/routes.js";
import { KINDS } from "../../src/backend/kubectl.js";

describe("kinds", () => {
  it("covers every backend kind once", () => {
    const listed = SECTIONS.flatMap((s) => s.kinds).sort();
    expect(listed).toEqual(Object.keys(KINDS).sort());
    expect(Object.keys(COLUMNS).sort()).toEqual(listed);
  });

  it("offers the same actions as the backend allows", () => {
    expect(ACTION_KINDS).toEqual(BACKEND_ACTION_KINDS);
    expect(supports("deployments", "scale")).toBe(true);
    expect(supports("daemonsets", "scale")).toBe(false);
  });

  it("picks detail tabs per kind", () => {
    expect(detailTabs("pods")).toEqual([
      "overview",
      "logs",
      "console",
      "metrics",
      "yaml",
      "events",
    ]);
    expect(detailTabs("deployments")).toEqual([
      "overview",
      "pods",
      "logs",
      "history",
      "yaml",
      "events",
    ]);
    expect(detailTabs("secrets")).toContain("data");
    expect(detailTabs("events")).toEqual(["overview"]);
  });
});

describe("formatting", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("shows ages like kubectl", () => {
    expect(age("2026-10-21T11:59:30Z", now)).toBe("30s");
    expect(age("2026-10-21T11:15:00Z", now)).toBe("45m");
    expect(age("2026-10-20T12:00:00Z", now)).toBe("24h");
    expect(age("2026-10-11T12:00:00Z", now)).toBe("10d");
    expect(age("", now)).toBe("");
  });

  it("formats durations, CPU and memory", () => {
    expect(duration(90)).toBe("1m 30s");
    expect(duration(3720)).toBe("1h 2m");
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(1500)).toBe("1.50");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MiB");
    expect(formatBytes(null)).toBe("");
  });

  it("groups tones for the status filter", () => {
    expect(toneFilter("ok")).toBe("healthy");
    expect(toneFilter("warn")).toBe("problem");
    expect(toneFilter("error")).toBe("problem");
    expect(toneFilter("idle")).toBe("idle");
  });

  it("colors helm statuses", () => {
    expect(helmTone("deployed")).toBe("success");
    expect(helmTone("failed")).toBe("destructive");
    expect(helmTone("pending-upgrade")).toBe("warning");
    expect(helmTone("superseded")).toBe("muted");
  });

  it("keeps the newest 60 metric samples", () => {
    let samples: { at: string; rows: [] }[] = [];
    for (let i = 0; i < 70; i++) {
      samples = pushSample(samples, {
        at: String(i),
        rows: [],
      }) as typeof samples;
    }
    expect(samples).toHaveLength(60);
    expect(samples[0].at).toBe("10");
  });

  it("measures usage against limits, else the node", () => {
    const pod = {
      kind: "pods" as const,
      name: "a",
      created: "",
      status: "Running",
      tone: "ok" as const,
      fields: {},
      resources: [
        {
          name: "a",
          cpuLimit: 500,
          memoryLimit: null,
          cpuRequest: null,
          memoryRequest: null,
        },
        {
          name: "b",
          cpuLimit: 250,
          memoryLimit: 1024,
          cpuRequest: null,
          memoryRequest: null,
        },
      ],
    };
    const node = { cpu: 2000, memory: 4096 };
    expect(usageBase(pod, node, "cpu")).toEqual({ value: 750, of: "limit" });
    expect(usageBase(pod, node, "memory")).toEqual({ value: 4096, of: "node" });
    expect(usageBase(pod, null, "memory")).toBeNull();
  });
});
