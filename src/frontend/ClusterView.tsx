import React from "react";
import {
  ExternalLink,
  FilePlus2,
  Inbox,
  Lock,
  RefreshCw,
  ShipWheel,
} from "lucide-react";
import {
  usePluginUiPreferences,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  Facts,
  PanelSearch,
  PanelShell,
  Segmented,
  Select2,
  ViewToggle,
  type GridSize,
  cn,
  useAdaptivePolling,
} from "@termix-ssh/plugin-sdk/ui";
import { ClusterProvider, type ClusterValue } from "./cluster-context";
import { ApplyView } from "./components/ApplyView";
import { HelmDetail, HelmList } from "./components/HelmView";
import { ResourceDetail } from "./components/ResourceDetail";
import { ResourceList, usageKey } from "./components/ResourceList";
import { docsUrl } from "./docs";
import { getErrorMessage } from "./error-message";
import {
  SECTIONS,
  isNamespaced,
  toneFilter,
  type DetailTab,
  type SectionId,
} from "./kinds";
import { useKubernetesApi } from "./kubernetes-api";
import type {
  HelmRelease,
  KindId,
  KubeHost,
  KubeValidation,
  ResourceRef,
  ResourceSummary,
  UsageRow,
} from "./types";

const FLAVOR_LABEL: Record<KubeValidation["flavor"], string> = {
  kubectl: "Kubernetes",
  k3s: "k3s",
  microk8s: "MicroK8s",
  oc: "OpenShift",
};

const COMPACT_KINDS: KindId[] = ["pods", "deployments", "statefulsets", "jobs"];

type StatusFilter = "all" | "healthy" | "problem" | "idle";

interface ClusterViewProps {
  sessionId: string;
  host: KubeHost;
  validation: KubeValidation;
  title?: string;
  compact: boolean;
}

export function ClusterView({
  sessionId,
  host,
  validation,
  title,
  compact,
}: ClusterViewProps) {
  const { t } = useTranslation();
  const kube = useKubernetesApi();
  const { values: prefs, set: setPref } = usePluginUiPreferences<{
    layout: "card" | "table";
    columns: GridSize;
  }>();

  const [contexts, setContexts] = React.useState<string[]>([]);
  const [context, setContext] = React.useState<string | undefined>(undefined);
  const [currentContext, setCurrentContext] = React.useState<string | null>(
    null,
  );
  const [namespaces, setNamespaces] = React.useState<string[]>([]);
  const [restricted, setRestricted] = React.useState(false);
  const [namespace, setNamespace] = React.useState(validation.namespace);
  const [section, setSection] = React.useState<SectionId>("workloads");
  const [kind, setKind] = React.useState<KindId>("pods");
  const [rows, setRows] = React.useState<ResourceSummary[]>([]);
  const [releases, setReleases] = React.useState<HelmRelease[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [usage, setUsage] = React.useState<Map<string, UsageRow>>(new Map());
  const [metricsOn, setMetricsOn] = React.useState(true);
  const [selected, setSelected] = React.useState<{
    ref: ResourceRef;
    tab?: DetailTab;
  } | null>(null);
  const [release, setRelease] = React.useState<HelmRelease | null>(null);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [layout, setLayout] = React.useState(prefs.layout ?? "table");
  const [columns, setColumns] = React.useState<GridSize>(
    prefs.columns ?? "auto",
  );
  const [applyOpen, setApplyOpen] = React.useState(false);

  const isHelm = section === "helm";
  const scope = { context, namespace: namespace || undefined };
  const listKey = `${context ?? ""}|${namespace}|${isHelm ? "helm" : kind}`;
  const listKeyRef = React.useRef(listKey);
  listKeyRef.current = listKey;

  React.useEffect(() => {
    kube
      .contexts(sessionId)
      .then((out) => {
        setContexts(out.contexts);
        setCurrentContext(out.current);
      })
      .catch(() => setContexts([]));
  }, [kube, sessionId]);

  React.useEffect(() => {
    kube
      .namespaces(sessionId, context)
      .then((out) => {
        setNamespaces(out.namespaces);
        setRestricted(out.restricted);
      })
      .catch(() => setNamespaces([]));
  }, [kube, sessionId, context]);

  React.useEffect(() => {
    setRows([]);
    setReleases([]);
    setLoaded(false);
    setError(null);
    setUsage(new Map());
  }, [listKey]);

  const loadList = React.useCallback(async () => {
    const key = listKeyRef.current;
    setLoading(true);
    try {
      if (isHelm) {
        const next = await kube.helmReleases(sessionId, scope);
        if (key !== listKeyRef.current) return false;
        setReleases(next);
      } else {
        const next = await kube.list(sessionId, kind, scope);
        if (key !== listKeyRef.current) return false;
        setRows(next);
      }
      setError(null);
      return true;
    } catch (err) {
      if (key === listKeyRef.current) setError(getErrorMessage(err));
      return false;
    } finally {
      if (key === listKeyRef.current) {
        setLoaded(true);
        setLoading(false);
      }
    }
    // scope is rebuilt each render from context and namespace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kube, sessionId, kind, isHelm, context, namespace]);

  const detailOpen = !!selected || !!release;

  useAdaptivePolling(
    loadList,
    { minIntervalMs: 5_000, maxIntervalMs: 30_000, stablePollsPerStep: 3 },
    !detailOpen,
  );

  const usageKind = kind === "pods" || kind === "nodes" ? kind : null;
  useAdaptivePolling(
    async () => {
      if (!usageKind) return false;
      const result =
        usageKind === "pods"
          ? await kube.podMetrics(sessionId, scope)
          : await kube.nodeMetrics(sessionId, context);
      if (!result.available) {
        setMetricsOn(false);
        return false;
      }
      setUsage(
        new Map(result.rows.map((row) => [usageKey(usageKind, row), row])),
      );
      return true;
    },
    { minIntervalMs: 15_000, maxIntervalMs: 60_000, stablePollsPerStep: 2 },
    !!usageKind && metricsOn && !detailOpen && !isHelm && !compact,
  );

  const open = React.useCallback((ref: ResourceRef, tab?: DetailTab) => {
    setSelected({ ref, tab });
  }, []);

  const cluster: ClusterValue = React.useMemo(
    () => ({
      sessionId,
      host,
      validation,
      context,
      readOnly: validation.readOnly,
      compact,
      open,
    }),
    [sessionId, host, validation, context, compact, open],
  );

  const pickSection = (next: SectionId) => {
    setSection(next);
    const first = SECTIONS.find((s) => s.id === next)?.kinds[0];
    if (first) setKind(first);
    setStatusFilter("all");
  };

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "all" && toneFilter(row.tone) !== statusFilter)
        return false;
      if (!query) return true;
      return (
        row.name.toLowerCase().includes(query) ||
        (row.namespace ?? "").toLowerCase().includes(query) ||
        row.status.toLowerCase().includes(query) ||
        Object.values(row.fields).some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(query),
        )
      );
    });
  }, [rows, search, statusFilter]);

  const filteredReleases = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return releases;
    return releases.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.chart.toLowerCase().includes(query) ||
        r.namespace.includes(query),
    );
  }, [releases, search]);

  if (selected) {
    return (
      <ClusterProvider value={cluster}>
        <ResourceDetail
          target={selected.ref}
          initialTab={selected.tab}
          onBack={() => setSelected(null)}
        />
      </ClusterProvider>
    );
  }

  if (release) {
    return (
      <ClusterProvider value={cluster}>
        <HelmDetail
          release={release}
          onBack={() => setRelease(null)}
          onChanged={() => void loadList()}
        />
      </ClusterProvider>
    );
  }

  const sectionKinds = SECTIONS.find((s) => s.id === section)?.kinds ?? [];
  const namespaceMatters = isHelm || isNamespaced(kind);

  const namespacePicker = (
    <Select2
      value={namespace}
      onChange={(e) => setNamespace(e.target.value)}
      disabled={!namespaceMatters}
      aria-label={t("toolbar.namespace")}
      title={t("toolbar.namespace")}
      className={cn("h-8 text-xs", compact ? "w-28" : "w-40")}
    >
      {!restricted && <option value="">{t("toolbar.allNamespaces")}</option>}
      {[...new Set([...namespaces, validation.namespace])]
        .filter(Boolean)
        .sort()
        .map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
    </Select2>
  );

  const toolbar = compact ? (
    <>
      <Select2
        value={kind}
        onChange={(e) => setKind(e.target.value as KindId)}
        aria-label={t("toolbar.kind")}
        className="h-8 w-28 text-xs"
      >
        {COMPACT_KINDS.map((id) => (
          <option key={id} value={id}>
            {t(`kinds.${id}.many`)}
          </option>
        ))}
      </Select2>
      {namespacePicker}
      <PanelSearch
        value={search}
        onChange={setSearch}
        placeholder={t("toolbar.search")}
      />
    </>
  ) : (
    <>
      <Segmented
        value={section}
        onChange={pickSection}
        options={SECTIONS.filter((s) => s.id !== "helm" || validation.helm).map(
          (s) => ({ value: s.id, label: t(`sections.${s.id}`) }),
        )}
      />
      {sectionKinds.length > 1 && (
        <Select2
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as KindId);
            setStatusFilter("all");
          }}
          aria-label={t("toolbar.kind")}
          className="h-8 w-40 text-xs"
        >
          {sectionKinds.map((id) => (
            <option key={id} value={id}>
              {t(`kinds.${id}.many`)}
            </option>
          ))}
        </Select2>
      )}
      {namespacePicker}
      {contexts.length > 1 && (
        <Select2
          value={context ?? currentContext ?? ""}
          onChange={(e) => setContext(e.target.value || undefined)}
          aria-label={t("toolbar.context")}
          title={t("toolbar.context")}
          className="h-8 w-44 text-xs"
        >
          {contexts.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select2>
      )}
      <PanelSearch
        value={search}
        onChange={setSearch}
        placeholder={t("toolbar.search")}
      />
      {!isHelm && kind !== "events" && (
        <Segmented
          value={statusFilter}
          onChange={(next) => setStatusFilter(next as StatusFilter)}
          options={(["all", "healthy", "problem", "idle"] as const).map(
            (value) => ({ value, label: t(`filters.${value}`) }),
          )}
        />
      )}
      <div className="ml-auto flex items-center gap-2">
        <ViewToggle
          view={layout === "table" ? "list" : "grid"}
          onView={(next) => {
            const value = next === "list" ? "table" : "card";
            setLayout(value);
            setPref("layout", value);
          }}
          columns={columns}
          onColumns={(next) => {
            setColumns(next);
            setPref("columns", next);
          }}
        />
      </div>
    </>
  );

  const versionText = validation.version?.server
    ? `${FLAVOR_LABEL[validation.flavor]} ${validation.version.server}`
    : FLAVOR_LABEL[validation.flavor];

  return (
    <ClusterProvider value={cluster}>
      <PanelShell
        icon={<ShipWheel className="size-4" />}
        title={compact ? t("nav.kubernetes") : title}
        status={
          <Facts>
            {versionText}
            {!compact && (context ?? currentContext)}
            {validation.readOnly && (
              <span className="flex items-center gap-1 text-warning">
                <Lock className="size-3" />
                {t("cluster.readOnly")}
              </span>
            )}
          </Facts>
        }
        actions={
          <>
            {!compact && !validation.readOnly && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setApplyOpen(true)}
                title={t("apply.title")}
                aria-label={t("apply.title")}
              >
                <FilePlus2 className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void loadList()}
              disabled={loading}
              title={t("kube.refresh")}
              aria-label={t("kube.refresh")}
              className="text-accent-brand"
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
            {!compact && (
              <a
                href={docsUrl()}
                target="_blank"
                rel="noreferrer"
                className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                title={t("hosts.docsLink")}
              >
                <ExternalLink className="size-4" />
              </a>
            )}
          </>
        }
        toolbar={toolbar}
        className="p-2.5 gap-2"
      >
        {!loaded ? (
          <div className="flex flex-col items-center justify-center py-20 opacity-40">
            <RefreshCw className="mb-4 size-8 animate-spin" />
            <span className="text-sm font-semibold">
              {t("cluster.loading")}
            </span>
          </div>
        ) : error ? (
          <div className="border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        ) : isHelm ? (
          <HelmList
            releases={filteredReleases}
            view={layout === "table" ? "list" : "grid"}
            size={columns}
            showNamespace={!namespace}
            onOpen={setRelease}
          />
        ) : (
          <ResourceList
            kind={kind}
            rows={filtered}
            view={layout === "table" ? "list" : "grid"}
            size={columns}
            showNamespace={!namespace}
            usage={usage}
            compact={compact}
            empty={
              <EmptyState
                icon={Inbox}
                title={
                  search || statusFilter !== "all"
                    ? t("cluster.noMatches")
                    : t("cluster.empty", { kind: t(`kinds.${kind}.many`) })
                }
              />
            }
            onOpen={(row) =>
              open({ kind: row.kind, name: row.name, namespace: row.namespace })
            }
            onChanged={() => void loadList()}
          />
        )}
      </PanelShell>
      <ApplyView
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        namespace={namespace || undefined}
        onApplied={() => void loadList()}
      />
    </ClusterProvider>
  );
}
