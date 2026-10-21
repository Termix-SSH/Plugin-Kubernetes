/**
 * Turns `kubectl get <kind> -o json` into the small rows the panel shows.
 * Every parser is pure so it can be tested on recorded output.
 */

import { KINDS, type KindId } from "./kubectl.js";
import { parseCpu, parseMemory } from "./metrics.js";

export type Tone = "ok" | "warn" | "error" | "idle";

export interface ResourceSummary {
  kind: KindId;
  name: string;
  namespace?: string;
  created: string;
  status: string;
  tone: Tone;
  /** Columns for the table, by key. */
  fields: Record<string, string | number | null>;
  labels?: Record<string, string>;
  /** Container names, for logs, the console and set image. */
  containers?: string[];
  images?: string[];
  replicas?: number;
  suspended?: boolean;
  unschedulable?: boolean;
  /** Secret keys only, never values. */
  keys?: string[];
  /** Per container limits and requests (CPU in millicores, memory in bytes). */
  resources?: ContainerResources[];
  /** What a node can hold, for usage percentages. */
  capacity?: { cpu: number | null; memory: number | null };
}

export interface ContainerResources {
  name: string;
  cpuLimit: number | null;
  memoryLimit: number | null;
  cpuRequest: number | null;
  memoryRequest: number | null;
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const entries = Object.entries(obj(value)).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The items of a List, or the object itself when kubectl got one by name. */
export function parseItems(output: string): Obj[] {
  const parsed = obj(JSON.parse(output));
  if (Array.isArray(parsed.items)) return parsed.items.map(obj);
  return Object.keys(parsed).length > 0 ? [parsed] : [];
}

function containersOf(spec: Obj): { names: string[]; images: string[] } {
  const list = arr(spec.containers).map(obj);
  return {
    names: list.map((c) => str(c.name)).filter(Boolean),
    images: list.map((c) => str(c.image)).filter(Boolean),
  };
}

function podTemplateOf(item: Obj): Obj {
  return obj(obj(obj(item.spec).template).spec);
}

/** What `kubectl get pods` shows in its STATUS column. */
export function podStatus(item: Obj): { status: string; tone: Tone } {
  const meta = obj(item.metadata);
  const status = obj(item.status);
  if (meta.deletionTimestamp) return { status: "Terminating", tone: "warn" };
  const phase = str(status.phase) || "Unknown";
  let reason = str(status.reason);
  const all = [
    ...arr(status.initContainerStatuses),
    ...arr(status.containerStatuses),
  ].map(obj);
  for (const cs of all) {
    const state = obj(cs.state);
    const waiting = str(obj(state.waiting).reason);
    const terminated = obj(state.terminated);
    if (waiting && waiting !== "PodInitializing") {
      reason = waiting;
      break;
    }
    if (str(terminated.reason) && num(terminated.exitCode) !== 0) {
      reason = str(terminated.reason);
      break;
    }
  }
  const shown = reason || phase;
  if (shown === "Running") {
    const ready = arr(status.containerStatuses)
      .map(obj)
      .every((cs) => cs.ready === true);
    return { status: shown, tone: ready ? "ok" : "warn" };
  }
  if (shown === "Succeeded" || shown === "Completed")
    return { status: "Completed", tone: "idle" };
  if (shown === "Pending" || shown === "ContainerCreating")
    return { status: shown, tone: "warn" };
  return { status: shown, tone: "error" };
}

function base(
  kind: KindId,
  item: Obj,
): Omit<ResourceSummary, "status" | "tone" | "fields"> {
  const meta = obj(item.metadata);
  const out: Omit<ResourceSummary, "status" | "tone" | "fields"> = {
    kind,
    name: str(meta.name),
    created: str(meta.creationTimestamp),
    labels: stringMap(meta.labels),
  };
  if (KINDS[kind].namespaced) out.namespace = str(meta.namespace);
  return out;
}

function rolloutTone(ready: number, desired: number): Tone {
  if (desired === 0) return "idle";
  if (ready >= desired) return "ok";
  return ready === 0 ? "error" : "warn";
}

function quantity(
  map: Obj,
  key: string,
  parse: (value: string) => number | null,
): number | null {
  const value = map[key];
  return typeof value === "string" ? parse(value) : null;
}

function containerResources(spec: Obj): ContainerResources[] {
  return arr(spec.containers)
    .map(obj)
    .map((c) => {
      const res = obj(c.resources);
      const limits = obj(res.limits);
      const requests = obj(res.requests);
      return {
        name: str(c.name),
        cpuLimit: quantity(limits, "cpu", parseCpu),
        memoryLimit: quantity(limits, "memory", parseMemory),
        cpuRequest: quantity(requests, "cpu", parseCpu),
        memoryRequest: quantity(requests, "memory", parseMemory),
      };
    });
}

function podRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const status = obj(item.status);
  const statuses = arr(status.containerStatuses).map(obj);
  const { names, images } = containersOf(spec);
  const ready = statuses.filter((cs) => cs.ready === true).length;
  const restarts = statuses.reduce((sum, cs) => sum + num(cs.restartCount), 0);
  const owner = obj(arr(obj(item.metadata).ownerReferences)[0]);
  return {
    ...base("pods", item),
    ...podStatus(item),
    containers: names,
    images,
    resources: containerResources(spec),
    fields: {
      ready: `${ready}/${names.length}`,
      restarts,
      node: str(spec.nodeName) || null,
      ip: str(status.podIP) || null,
      owner: owner.kind ? `${str(owner.kind)}/${str(owner.name)}` : null,
    },
  };
}

function workloadRow(kind: KindId, item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const status = obj(item.status);
  const { names, images } = containersOf(podTemplateOf(item));
  const desired =
    kind === "daemonsets"
      ? num(status.desiredNumberScheduled)
      : typeof spec.replicas === "number"
        ? spec.replicas
        : 1;
  const ready =
    kind === "daemonsets" ? num(status.numberReady) : num(status.readyReplicas);
  const fields: ResourceSummary["fields"] = {
    ready: `${ready}/${desired}`,
    images: images.join(", "),
  };
  if (kind === "deployments" || kind === "daemonsets") {
    fields.upToDate = num(
      kind === "daemonsets"
        ? status.updatedNumberScheduled
        : status.updatedReplicas,
    );
    fields.available = num(
      kind === "daemonsets" ? status.numberAvailable : status.availableReplicas,
    );
  }
  const tone = rolloutTone(ready, desired);
  return {
    ...base(kind, item),
    status:
      tone === "idle"
        ? "Scaled down"
        : tone === "ok"
          ? "Ready"
          : ready === 0
            ? "Unavailable"
            : "Updating",
    tone,
    containers: names,
    images,
    replicas: kind === "daemonsets" ? undefined : desired,
    fields,
  };
}

function jobRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const status = obj(item.status);
  const completions =
    typeof spec.completions === "number" ? spec.completions : 1;
  const succeeded = num(status.succeeded);
  const conditions = arr(status.conditions).map(obj);
  const has = (type: string) =>
    conditions.some((c) => c.type === type && c.status === "True");
  let state: { status: string; tone: Tone };
  if (has("Complete")) state = { status: "Complete", tone: "ok" };
  else if (has("Failed")) state = { status: "Failed", tone: "error" };
  else if (spec.suspend === true) state = { status: "Suspended", tone: "idle" };
  else state = { status: "Running", tone: "warn" };
  const start = Date.parse(str(status.startTime));
  const end = Date.parse(str(status.completionTime));
  const { names, images } = containersOf(podTemplateOf(item));
  return {
    ...base("jobs", item),
    ...state,
    containers: names,
    images,
    suspended: spec.suspend === true,
    fields: {
      completions: `${succeeded}/${completions}`,
      duration:
        Number.isFinite(start) && Number.isFinite(end)
          ? Math.round((end - start) / 1000)
          : null,
    },
  };
}

function cronJobRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const status = obj(item.status);
  const active = arr(status.active).length;
  const suspended = spec.suspend === true;
  const jobSpec = obj(obj(obj(spec.jobTemplate).spec).template);
  const { names, images } = containersOf(obj(jobSpec.spec));
  return {
    ...base("cronjobs", item),
    status: suspended ? "Suspended" : active > 0 ? "Active" : "Scheduled",
    tone: suspended ? "idle" : "ok",
    suspended,
    containers: names,
    images,
    fields: {
      schedule: str(spec.schedule),
      active,
      lastSchedule: str(status.lastScheduleTime) || null,
    },
  };
}

function servicePorts(spec: Obj): string {
  return arr(spec.ports)
    .map(obj)
    .map((p) => {
      const port = num(p.port);
      const node = num(p.nodePort);
      const proto = str(p.protocol) || "TCP";
      return `${port}${node ? `:${node}` : ""}/${proto}`;
    })
    .join(", ");
}

function serviceRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const ingress = arr(obj(obj(item.status).loadBalancer).ingress).map(obj);
  const external = [
    ...arr(spec.externalIPs).map(str),
    ...ingress.map((i) => str(i.ip) || str(i.hostname)),
  ].filter(Boolean);
  const type = str(spec.type) || "ClusterIP";
  const pending = type === "LoadBalancer" && external.length === 0;
  return {
    ...base("services", item),
    status: pending ? "Pending" : type,
    tone: pending ? "warn" : "ok",
    fields: {
      type,
      clusterIP: str(spec.clusterIP) || null,
      externalIP: external.join(", ") || null,
      ports: servicePorts(spec),
    },
  };
}

function ingressRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const hosts = arr(spec.rules)
    .map((r) => str(obj(r).host) || "*")
    .join(", ");
  const address = arr(obj(obj(item.status).loadBalancer).ingress)
    .map(obj)
    .map((i) => str(i.ip) || str(i.hostname))
    .filter(Boolean)
    .join(", ");
  return {
    ...base("ingresses", item),
    status: address ? "Ready" : "Pending",
    tone: address ? "ok" : "warn",
    fields: {
      class: str(spec.ingressClassName) || null,
      hosts,
      address: address || null,
      tls: arr(spec.tls).length > 0 ? "yes" : "no",
    },
  };
}

function configMapRow(item: Obj): ResourceSummary {
  const keys = [
    ...Object.keys(obj(item.data)),
    ...Object.keys(obj(item.binaryData)),
  ];
  return {
    ...base("configmaps", item),
    status: "Active",
    tone: "ok",
    keys,
    fields: { keys: keys.length },
  };
}

function secretRow(item: Obj): ResourceSummary {
  const keys = Object.keys(obj(item.data));
  return {
    ...base("secrets", item),
    status: "Active",
    tone: "ok",
    keys,
    fields: { type: str(item.type) || "Opaque", keys: keys.length },
  };
}

function phaseTone(phase: string): Tone {
  if (phase === "Bound" || phase === "Active" || phase === "Available")
    return "ok";
  if (phase === "Pending" || phase === "Released" || phase === "Terminating")
    return "warn";
  return "error";
}

function pvcRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const status = obj(item.status);
  const phase = str(status.phase) || "Pending";
  return {
    ...base("pvcs", item),
    status: phase,
    tone: phaseTone(phase),
    fields: {
      volume: str(spec.volumeName) || null,
      capacity: str(obj(status.capacity).storage) || null,
      access: arr(spec.accessModes).map(str).join(", "),
      storageClass: str(spec.storageClassName) || null,
    },
  };
}

function pvRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const phase = str(obj(item.status).phase) || "Pending";
  const claim = obj(spec.claimRef);
  return {
    ...base("pvs", item),
    status: phase,
    tone: phaseTone(phase),
    fields: {
      capacity: str(obj(spec.capacity).storage) || null,
      access: arr(spec.accessModes).map(str).join(", "),
      reclaim: str(spec.persistentVolumeReclaimPolicy) || null,
      claim: claim.name ? `${str(claim.namespace)}/${str(claim.name)}` : null,
      storageClass: str(spec.storageClassName) || null,
    },
  };
}

const ROLE_PREFIX = "node-role.kubernetes.io/";

function nodeRow(item: Obj): ResourceSummary {
  const spec = obj(item.spec);
  const status = obj(item.status);
  const labels = stringMap(obj(item.metadata).labels) ?? {};
  const roles = Object.keys(labels)
    .filter((key) => key.startsWith(ROLE_PREFIX))
    .map((key) => key.slice(ROLE_PREFIX.length))
    .filter(Boolean);
  const ready = arr(status.conditions)
    .map(obj)
    .find((c) => c.type === "Ready");
  const isReady = ready?.status === "True";
  const unschedulable = spec.unschedulable === true;
  const info = obj(status.nodeInfo);
  const internal = arr(status.addresses)
    .map(obj)
    .find((a) => a.type === "InternalIP");
  const capacity = obj(status.capacity);
  return {
    ...base("nodes", item),
    status: `${isReady ? "Ready" : "NotReady"}${unschedulable ? ", SchedulingDisabled" : ""}`,
    tone: !isReady ? "error" : unschedulable ? "warn" : "ok",
    unschedulable,
    capacity: {
      cpu: quantity(obj(status.allocatable), "cpu", parseCpu),
      memory: quantity(obj(status.allocatable), "memory", parseMemory),
    },
    fields: {
      roles: roles.join(", ") || null,
      version: str(info.kubeletVersion) || null,
      internalIP: str(internal?.address) || null,
      os: str(info.osImage) || null,
      cpu: str(capacity.cpu) || null,
      memory: str(capacity.memory) || null,
    },
  };
}

function namespaceRow(item: Obj): ResourceSummary {
  const phase = str(obj(item.status).phase) || "Active";
  return {
    ...base("namespaces", item),
    status: phase,
    tone: phaseTone(phase),
    fields: {},
  };
}

function eventRow(item: Obj): ResourceSummary {
  const involved = obj(item.involvedObject ?? item.regarding);
  const type = str(item.type) || "Normal";
  const last =
    str(item.lastTimestamp) ||
    str(item.eventTime) ||
    str(obj(item.series).lastObservedTime) ||
    str(obj(item.metadata).creationTimestamp);
  return {
    ...base("events", item),
    created: last,
    status: type,
    tone: type === "Warning" ? "warn" : "ok",
    fields: {
      reason: str(item.reason) || null,
      object: involved.kind
        ? `${str(involved.kind)}/${str(involved.name)}`
        : null,
      message: str(item.message || item.note) || null,
      count: num(item.count) || num(obj(item.series).count) || 1,
    },
  };
}

export function summarize(kind: KindId, item: Obj): ResourceSummary {
  switch (kind) {
    case "pods":
      return podRow(item);
    case "deployments":
    case "statefulsets":
    case "daemonsets":
    case "replicasets":
      return workloadRow(kind, item);
    case "jobs":
      return jobRow(item);
    case "cronjobs":
      return cronJobRow(item);
    case "services":
      return serviceRow(item);
    case "ingresses":
      return ingressRow(item);
    case "configmaps":
      return configMapRow(item);
    case "secrets":
      return secretRow(item);
    case "pvcs":
      return pvcRow(item);
    case "pvs":
      return pvRow(item);
    case "nodes":
      return nodeRow(item);
    case "namespaces":
      return namespaceRow(item);
    case "events":
      return eventRow(item);
  }
}

export function parseResourceList(
  kind: KindId,
  output: string,
): ResourceSummary[] {
  const rows = parseItems(output).map((item) => summarize(kind, item));
  if (kind === "events") {
    // Newest first, like a log.
    rows.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  }
  return rows;
}

/** The label selector a workload or service uses to find its pods. */
export function selectorLabels(kind: KindId, item: Obj): Obj | null {
  const spec = obj(item.spec);
  if (kind === "services") {
    const selector = obj(spec.selector);
    return Object.keys(selector).length > 0 ? selector : null;
  }
  const match = obj(obj(spec.selector).matchLabels);
  return Object.keys(match).length > 0 ? match : null;
}

/** Plain configmap data. Binary keys are listed but not shown. */
export function configMapData(item: Obj): Record<string, string> {
  return stringMap(item.data) ?? {};
}

/** Decoded secret values. Binary values come back as base64. */
export function decodeSecret(item: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj(item.data))) {
    if (typeof value !== "string") continue;
    const bytes = Buffer.from(value, "base64");
    const text = bytes.toString("utf-8");
    out[key] = Buffer.from(text, "utf-8").equals(bytes) ? text : value;
  }
  return out;
}

export interface RolloutRevision {
  revision: number;
  changeCause: string | null;
}

/** Parses `kubectl rollout history` text. */
export function parseRolloutHistory(output: string): RolloutRevision[] {
  return output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      revision: Number(match[1]),
      changeCause: match[2] && match[2] !== "<none>" ? match[2] : null,
    }))
    .sort((a, b) => b.revision - a.revision);
}
