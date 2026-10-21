export type KindId =
  | "pods"
  | "deployments"
  | "statefulsets"
  | "daemonsets"
  | "replicasets"
  | "jobs"
  | "cronjobs"
  | "services"
  | "ingresses"
  | "configmaps"
  | "secrets"
  | "pvcs"
  | "pvs"
  | "nodes"
  | "namespaces"
  | "events";

export type Tone = "ok" | "warn" | "error" | "idle";

export interface ResourceSummary {
  kind: KindId;
  name: string;
  namespace?: string;
  created: string;
  status: string;
  tone: Tone;
  fields: Record<string, string | number | null>;
  labels?: Record<string, string>;
  containers?: string[];
  images?: string[];
  replicas?: number;
  suspended?: boolean;
  unschedulable?: boolean;
  keys?: string[];
  resources?: ContainerResources[];
  capacity?: { cpu: number | null; memory: number | null };
}

export interface ContainerResources {
  name: string;
  cpuLimit: number | null;
  memoryLimit: number | null;
  cpuRequest: number | null;
  memoryRequest: number | null;
}

export interface ResourceDetailData {
  summary: ResourceSummary;
  describe: string;
  data?: Record<string, string>;
}

export interface KubeValidation {
  available: boolean;
  flavor: "kubectl" | "k3s" | "microk8s" | "oc";
  readOnly: boolean;
  namespace: string;
  version?: { client?: string; server?: string };
  helm?: string | null;
  canRevealSecrets?: boolean;
  error?: string;
  code?: string;
}

export type ResourceAction =
  | "scale"
  | "restart"
  | "undo"
  | "setImage"
  | "suspend"
  | "resume"
  | "trigger"
  | "cordon"
  | "uncordon"
  | "drain";

export interface RolloutRevision {
  revision: number;
  changeCause: string | null;
}

export interface UsageRow {
  namespace?: string;
  name: string;
  cpu: number | null;
  memory: number | null;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
}

export interface UsageResult {
  available: boolean;
  rows: UsageRow[];
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
}

export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

export interface LogQuery {
  container?: string;
  tail?: number;
  timestamps?: boolean;
  previous?: boolean;
  since?: string;
}

/** What the Kubernetes views read from a host. */
export interface KubeHost {
  id: number;
  name?: string;
  ip: string;
  port: number;
  username?: string;
  syncId?: string | null;
  connectionOrigin?: "local" | "remote" | null;
  pluginSettings?: Record<string, Record<string, unknown> | undefined>;
}

/** The fields toKubeHost reads from a shell or API host. */
export type KubeHostSource = Omit<KubeHost, "id" | "name"> & {
  id: string | number;
  name?: string | null;
};

/** Any host record the shell or an API hands over, as a KubeHost. */
export function toKubeHost(record: KubeHostSource): KubeHost {
  return {
    id: Number(record.id),
    name: record.name ?? undefined,
    ip: record.ip,
    port: record.port,
    username: record.username,
    syncId: record.syncId ?? null,
    connectionOrigin: record.connectionOrigin ?? null,
    pluginSettings: record.pluginSettings,
  };
}

function kubeSettings(
  host: object | null | undefined,
): Record<string, unknown> {
  const all = (host as { pluginSettings?: unknown } | null | undefined)
    ?.pluginSettings as
    Record<string, Record<string, unknown> | undefined> | undefined;
  return all?.kubernetes ?? {};
}

export function kubernetesEnabled(host: object | null | undefined): boolean {
  return kubeSettings(host).enableKubernetes === true;
}

/** Whether the side panel may open beside this host's terminal. */
export function kubernetesPanelEnabled(
  host: object | null | undefined,
): boolean {
  return kubernetesEnabled(host) && kubeSettings(host).showPanel !== false;
}

export function hostTitle(host: KubeHost): string {
  return host.name || `${host.username ?? ""}@${host.ip}`;
}

/** Points at one resource. Cluster kinds have no namespace. */
export interface ResourceRef {
  kind: KindId;
  name: string;
  namespace?: string;
}
