/**
 * Builds every kubectl and helm command the plugin runs. Values are checked
 * against strict patterns first and then single quoted, so nothing a caller
 * sends is ever read by the remote shell as code.
 */

export type KubectlFlavor = "kubectl" | "k3s" | "microk8s" | "oc";

export const KUBECTL_FLAVORS: KubectlFlavor[] = [
  "kubectl",
  "k3s",
  "microk8s",
  "oc",
];

export function normalizeFlavor(value: unknown): KubectlFlavor {
  return KUBECTL_FLAVORS.includes(value as KubectlFlavor)
    ? (value as KubectlFlavor)
    : "kubectl";
}

const FLAVOR_CLI: Record<KubectlFlavor, string> = {
  kubectl: "kubectl",
  k3s: "k3s kubectl",
  microk8s: "microk8s kubectl",
  oc: "oc",
};

export function flavorLabel(flavor: KubectlFlavor): string {
  return {
    kubectl: "kubectl",
    k3s: "k3s",
    microk8s: "MicroK8s",
    oc: "OpenShift",
  }[flavor];
}

/** Where kubectl runs and which cluster it talks to. */
export interface KubeTarget {
  flavor: KubectlFlavor;
  kubeconfig?: string;
  context?: string;
  sudo?: boolean;
}

// Non-interactive SSH shells skip profile files, so add the usual install dirs.
const EXTRA_PATH_DIRS =
  '/usr/local/bin:/snap/bin:/opt/homebrew/bin:"$HOME/.local/bin":"$HOME/bin"';

const K3S_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
export const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const CONTAINER_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const RELEASE_RE = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;
export const KUBECONFIG_RE = /^(~\/|\/)[A-Za-z0-9_./@:-]*$/;
// Contexts are free text (EKS ARNs, user@cluster), so only refuse control characters.
export const CONTEXT_RE = /^[^\0-\x1f\x7f]{1,253}$/;
export const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,511}$/;
export const SHELLS = ["bash", "sh", "ash", "zsh"] as const;
const LABEL_KEY_RE =
  /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE_RE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;

export function isName(value: unknown): value is string {
  return typeof value === "string" && NAME_RE.test(value);
}

export function isNamespace(value: unknown): value is string {
  return typeof value === "string" && NAMESPACE_RE.test(value);
}

export function isContext(value: unknown): value is string {
  return typeof value === "string" && CONTEXT_RE.test(value);
}

export function isKubeconfigPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    KUBECONFIG_RE.test(value) &&
    !value.split("/").includes("..")
  );
}

/** The resource kinds the plugin knows about, by their route id. */
export const KINDS = {
  pods: { resource: "pods", kind: "Pod", namespaced: true },
  deployments: {
    resource: "deployments.apps",
    kind: "Deployment",
    namespaced: true,
  },
  statefulsets: {
    resource: "statefulsets.apps",
    kind: "StatefulSet",
    namespaced: true,
  },
  daemonsets: {
    resource: "daemonsets.apps",
    kind: "DaemonSet",
    namespaced: true,
  },
  replicasets: {
    resource: "replicasets.apps",
    kind: "ReplicaSet",
    namespaced: true,
  },
  jobs: { resource: "jobs.batch", kind: "Job", namespaced: true },
  cronjobs: { resource: "cronjobs.batch", kind: "CronJob", namespaced: true },
  services: { resource: "services", kind: "Service", namespaced: true },
  ingresses: {
    resource: "ingresses.networking.k8s.io",
    kind: "Ingress",
    namespaced: true,
  },
  configmaps: { resource: "configmaps", kind: "ConfigMap", namespaced: true },
  secrets: { resource: "secrets", kind: "Secret", namespaced: true },
  pvcs: {
    resource: "persistentvolumeclaims",
    kind: "PersistentVolumeClaim",
    namespaced: true,
  },
  pvs: {
    resource: "persistentvolumes",
    kind: "PersistentVolume",
    namespaced: false,
  },
  nodes: { resource: "nodes", kind: "Node", namespaced: false },
  namespaces: { resource: "namespaces", kind: "Namespace", namespaced: false },
  events: { resource: "events", kind: "Event", namespaced: true },
} as const;

export type KindId = keyof typeof KINDS;

export function isKind(value: unknown): value is KindId {
  return typeof value === "string" && Object.hasOwn(KINDS, value);
}

/** Kinds whose pods can be found through a label selector. */
export const SELECTOR_KINDS: KindId[] = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "replicasets",
  "jobs",
  "services",
];

/** Turns `matchLabels` into a `-l` value, or null when a label looks wrong. */
export function labelSelector(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  if (!labels) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value !== "string") return null;
    if (!LABEL_KEY_RE.test(key) || !LABEL_VALUE_RE.test(value)) return null;
    parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

function pathArg(path: string): string {
  // Quoting stops ~ from expanding, so spell out $HOME.
  return path.startsWith("~/")
    ? `"$HOME"/${shellQuote(path.slice(2))}`
    : shellQuote(path);
}

function prefix(target: KubeTarget): string {
  // sudo resets PATH to secure_path, which already has /usr/local/bin and /snap/bin.
  return target.sudo ? "sudo -n" : `PATH="${EXTRA_PATH_DIRS}:$PATH"`;
}

/** A kubectl command line. `args` are quoted one by one. */
export function kubectl(target: KubeTarget, args: string[]): string {
  const parts = [prefix(target), FLAVOR_CLI[target.flavor]];
  if (target.kubeconfig)
    parts.push(`--kubeconfig=${pathArg(target.kubeconfig)}`);
  if (target.context) parts.push(`--context=${shellQuote(target.context)}`);
  for (const arg of args) parts.push(shellQuote(arg));
  return parts.join(" ");
}

/** A helm command line pointed at the same cluster as kubectl. */
export function helm(target: KubeTarget, args: string[]): string {
  const cli = target.flavor === "microk8s" ? "microk8s helm" : "helm";
  const parts = [prefix(target), cli];
  // helm doesn't know where k3s keeps its config.
  const kubeconfig =
    target.kubeconfig ?? (target.flavor === "k3s" ? K3S_KUBECONFIG : undefined);
  if (kubeconfig) parts.push(`--kubeconfig=${pathArg(kubeconfig)}`);
  if (target.context)
    parts.push(`--kube-context=${shellQuote(target.context)}`);
  for (const arg of args) parts.push(shellQuote(arg));
  return parts.join(" ");
}

/** `-n <ns>`, or `-A` for every namespace. Cluster kinds get nothing. */
export function namespaceArgs(
  kind: KindId,
  namespace: string | null,
): string[] {
  if (!KINDS[kind].namespaced) return [];
  return namespace ? ["-n", namespace] : ["-A"];
}
