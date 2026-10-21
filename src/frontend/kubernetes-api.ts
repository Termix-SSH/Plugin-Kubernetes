import { useMemo } from "react";
import {
  usePluginApi,
  type PluginApiClient,
} from "@termix-ssh/plugin-sdk/frontend";
import type { ConnectionStage } from "@termix-ssh/plugin-sdk/ui";
import type {
  HelmRelease,
  HelmRevision,
  KindId,
  KubeValidation,
  LogQuery,
  ResourceAction,
  ResourceDetailData,
  ResourceRef,
  ResourceSummary,
  RolloutRevision,
  UsageResult,
} from "./types";

export interface ApiConnectionLog {
  type: "info" | "success" | "warning" | "error";
  stage: ConnectionStage;
  message: string;
  details?: string;
}

/** One step of a connect: connected, a prompt to answer, or auth needed. */
export interface ConnectResult {
  success?: boolean;
  status?: string;
  reason?: string;
  message?: string;
  requires_totp?: boolean;
  prompt?: string;
  isPassword?: boolean;
  retry?: boolean;
  requires_browser_sign_in?: boolean;
  url?: string | null;
  code?: string;
  label?: string;
  connectionLogs?: ApiConnectionLog[];
}

/** An API failure carrying the server's message and connection logs. */
export class KubeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly connectionLogs?: ApiConnectionLog[],
  ) {
    super(message);
    this.name = "KubeApiError";
  }
}

function apiError(error: unknown, action: string): KubeApiError {
  const response = (
    error as {
      response?: {
        status?: number;
        data?: {
          error?: string;
          message?: string;
          code?: string;
          connectionLogs?: ApiConnectionLog[];
        };
      };
    }
  )?.response;
  const data = response?.data;
  const message =
    data?.error ||
    data?.message ||
    (error instanceof Error ? error.message : `Failed to ${action}`);
  return new KubeApiError(
    message,
    response?.status,
    data?.code,
    data?.connectionLogs,
  );
}

async function call<T>(
  action: string,
  request: () => Promise<{ data: T }>,
): Promise<T> {
  try {
    return (await request()).data;
  } catch (error) {
    throw apiError(error, action);
  }
}

/** Where a request points: a kubeconfig context and a namespace. */
export interface Scope {
  context?: string;
  namespace?: string;
}

function params(scope: Scope, extra?: object) {
  return {
    ...(scope.context ? { context: scope.context } : {}),
    ...(scope.namespace ? { namespace: scope.namespace } : {}),
    ...extra,
  };
}

function objectPath(sessionId: string, ref: ResourceRef): string {
  return `/resources/${sessionId}/${ref.kind}/${encodeURIComponent(ref.name)}`;
}

function objectScope(context: string | undefined, ref: ResourceRef): Scope {
  return { context, namespace: ref.namespace };
}

function createKubernetesApi(api: PluginApiClient) {
  return {
    connect: (
      sessionId: string,
      hostId: number,
      credentials?: {
        userProvidedPassword?: string;
        userProvidedSshKey?: string;
        userProvidedKeyPassword?: string;
      },
    ) =>
      call<ConnectResult>("connect to Kubernetes", () =>
        api.post("/ssh/connect", { sessionId, hostId, ...credentials }),
      ),

    answerTotp: (sessionId: string, totpCode: string) =>
      call<ConnectResult>("verify the code", () =>
        api.post("/ssh/connect-totp", { sessionId, totpCode }),
      ),

    continueBrowserSignIn: (sessionId: string) =>
      call<ConnectResult>("continue after a browser sign-in", () =>
        api.post("/ssh/connect-browser-sign-in", { sessionId }),
      ),

    disconnect: (sessionId: string) =>
      call("disconnect", () => api.post("/ssh/disconnect", { sessionId })),

    keepalive: (sessionId: string) =>
      call("keep the session alive", () =>
        api.post("/ssh/keepalive", { sessionId }),
      ),

    validate: (sessionId: string) =>
      call<KubeValidation>("check the cluster", () =>
        api.get(`/validate/${sessionId}`),
      ),

    contexts: (sessionId: string) =>
      call<{ contexts: string[]; current: string | null }>(
        "list contexts",
        () => api.get(`/contexts/${sessionId}`),
      ),

    namespaces: (sessionId: string, context?: string) =>
      call<{ namespaces: string[]; restricted: boolean }>(
        "list namespaces",
        () =>
          api.get(`/namespaces/${sessionId}`, { params: params({ context }) }),
      ),

    list: (sessionId: string, kind: KindId, scope: Scope) =>
      call<ResourceSummary[]>(`list ${kind}`, () =>
        api.get(`/resources/${sessionId}/${kind}`, { params: params(scope) }),
      ),

    get: (sessionId: string, ref: ResourceRef, context?: string) =>
      call<ResourceDetailData>(`load the ${ref.kind}`, () =>
        api.get(objectPath(sessionId, ref), {
          params: params(objectScope(context, ref)),
        }),
      ),

    yaml: (sessionId: string, ref: ResourceRef, context?: string) =>
      call<{ yaml: string }>("load the YAML", () =>
        api.get(`${objectPath(sessionId, ref)}/yaml`, {
          params: params(objectScope(context, ref)),
        }),
      ),

    events: (sessionId: string, ref: ResourceRef, context?: string) =>
      call<ResourceSummary[]>("load events", () =>
        api.get(`${objectPath(sessionId, ref)}/events`, {
          params: params(objectScope(context, ref)),
        }),
      ),

    pods: (sessionId: string, ref: ResourceRef, context?: string) =>
      call<ResourceSummary[]>("load pods", () =>
        api.get(`${objectPath(sessionId, ref)}/pods`, {
          params: params(objectScope(context, ref)),
        }),
      ),

    history: (sessionId: string, ref: ResourceRef, context?: string) =>
      call<RolloutRevision[]>("load the rollout history", () =>
        api.get(`${objectPath(sessionId, ref)}/history`, {
          params: params(objectScope(context, ref)),
        }),
      ),

    revision: (
      sessionId: string,
      ref: ResourceRef,
      revision: number,
      context?: string,
    ) =>
      call<{ details: string }>("load the revision", () =>
        api.get(`${objectPath(sessionId, ref)}/history`, {
          params: params(objectScope(context, ref), { revision }),
        }),
      ),

    logs: (
      sessionId: string,
      ref: ResourceRef,
      query: LogQuery,
      context?: string,
    ) =>
      call<{ logs: string }>("load logs", () =>
        api.get(`${objectPath(sessionId, ref)}/logs`, {
          params: params(objectScope(context, ref), query),
        }),
      ),

    remove: (
      sessionId: string,
      ref: ResourceRef,
      context?: string,
      force = false,
    ) =>
      call<{ success: boolean; output: string }>(`delete the ${ref.kind}`, () =>
        api.delete(objectPath(sessionId, ref), {
          params: params(objectScope(context, ref), force ? { force } : {}),
        }),
      ),

    action: (
      sessionId: string,
      ref: ResourceRef,
      action: ResourceAction,
      options: Record<string, unknown> = {},
      context?: string,
    ) =>
      call<{ success: boolean; output: string }>(`run ${action}`, () =>
        api.post(`${objectPath(sessionId, ref)}/action`, {
          ...params(objectScope(context, ref)),
          ...options,
          action,
        }),
      ),

    podMetrics: (sessionId: string, scope: Scope) =>
      call<UsageResult>("load pod metrics", () =>
        api.get(`/metrics/${sessionId}/pods`, { params: params(scope) }),
      ),

    nodeMetrics: (sessionId: string, context?: string) =>
      call<UsageResult>("load node metrics", () =>
        api.get(`/metrics/${sessionId}/nodes`, {
          params: params({ context }),
        }),
      ),

    containerMetrics: (sessionId: string, ref: ResourceRef, context?: string) =>
      call<UsageResult>("load pod metrics", () =>
        api.get(`/metrics/${sessionId}/pods/${encodeURIComponent(ref.name)}`, {
          params: params(objectScope(context, ref)),
        }),
      ),

    checkManifest: (sessionId: string, body: ManifestBody) =>
      call<{ success: boolean; resources: string[] }>(
        "check the manifest",
        () => api.post(`/manifests/${sessionId}/validate`, cleanBody(body)),
      ),

    diffManifest: (sessionId: string, body: ManifestBody) =>
      call<{ diff: string }>("diff the manifest", () =>
        api.post(`/manifests/${sessionId}/diff`, cleanBody(body)),
      ),

    applyManifest: (sessionId: string, body: ManifestBody) =>
      call<{ success: boolean; resources: string[] }>(
        "apply the manifest",
        () => api.post(`/manifests/${sessionId}/apply`, cleanBody(body)),
      ),

    revealSecret: (sessionId: string, ref: ResourceRef, context?: string) =>
      call<{ data: Record<string, string> }>("reveal the secret", () =>
        api.post(
          `/secrets/${sessionId}/${encodeURIComponent(ref.name)}/reveal`,
          params(objectScope(context, ref)),
        ),
      ),

    helmReleases: (sessionId: string, scope: Scope) =>
      call<HelmRelease[]>("list Helm releases", () =>
        api.get(`/helm/${sessionId}`, { params: params(scope) }),
      ),

    helmHistory: (sessionId: string, release: HelmRelease, context?: string) =>
      call<HelmRevision[]>("load the release history", () =>
        api.get(helmPath(sessionId, release, "history"), {
          params: params({ context }),
        }),
      ),

    helmValues: (
      sessionId: string,
      release: HelmRelease,
      all: boolean,
      context?: string,
    ) =>
      call<{ values: string }>("load the release values", () =>
        api.get(helmPath(sessionId, release, "values"), {
          params: params({ context }, all ? { all } : {}),
        }),
      ),

    helmManifest: (sessionId: string, release: HelmRelease, context?: string) =>
      call<{ manifest: string }>("load the release manifest", () =>
        api.get(helmPath(sessionId, release, "manifest"), {
          params: params({ context }),
        }),
      ),

    helmRollback: (
      sessionId: string,
      release: HelmRelease,
      revision?: number,
      context?: string,
    ) =>
      call<{ success: boolean; output: string }>("roll back the release", () =>
        api.post(helmPath(sessionId, release, "rollback"), {
          ...params({ context }),
          ...(revision ? { revision } : {}),
        }),
      ),

    helmUninstall: (
      sessionId: string,
      release: HelmRelease,
      context?: string,
    ) =>
      call<{ success: boolean; output: string }>("uninstall the release", () =>
        api.delete(helmPath(sessionId, release), {
          params: params({ context }),
        }),
      ),
  };
}

export interface ManifestBody {
  yaml: string;
  mode?: "apply" | "replace";
  namespace?: string;
  context?: string;
}

function cleanBody(body: ManifestBody) {
  return {
    yaml: body.yaml,
    ...(body.mode ? { mode: body.mode } : {}),
    ...params({ context: body.context, namespace: body.namespace }),
  };
}

function helmPath(sessionId: string, release: HelmRelease, tail?: string) {
  const base = `/helm/${sessionId}/${release.namespace}/${encodeURIComponent(release.name)}`;
  return tail ? `${base}/${tail}` : base;
}

export type KubernetesApi = ReturnType<typeof createKubernetesApi>;

/** The Kubernetes API on this plugin's own client. */
export function useKubernetesApi(): KubernetesApi {
  const api = usePluginApi();
  return useMemo(() => createKubernetesApi(api), [api]);
}
