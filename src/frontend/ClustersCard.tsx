import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShipWheel } from "lucide-react";
import {
  useHosts,
  usePermission,
  usePluginApi,
  useTabs,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListBadge,
  ListRow,
  PanelList,
} from "@termix-ssh/plugin-sdk/ui";

const POLL_MS = 60_000;

export interface ClusterSummary {
  hostId: number;
  nodesReady: number;
  nodesTotal: number;
  podsRunning: number;
  podsFailing: number;
  podsTotal: number;
  error?: string;
  checkedAt: string;
}

/** Dashboard card: ready nodes and failing pods on each cluster. */
export function ClustersCard({ isVisible }: DashboardCardProps) {
  const { t } = useTranslation();
  const allowed = usePermission("use");
  const api = usePluginApi();
  const tabs = useTabs();
  const { hosts } = useHosts();
  const [rows, setRows] = useState<ClusterSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const { data } = await api.get<ClusterSummary[]>("/summary", {
          params: refresh ? { refresh: "1" } : undefined,
        });
        setRows(data);
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!isVisible || !allowed) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, allowed, load]);

  if (!allowed) return null;
  if (!rows) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("card.loading")}</p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-end px-3 pt-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={loading}
          onClick={() => void load(true)}
          title={t("card.refresh")}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <PanelList
        empty={
          <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
        }
      >
        {rows.map((row, index) => {
          const host = hosts.find((h) => Number(h.id) === row.hostId);
          const nodesDown = row.nodesTotal - row.nodesReady;
          return (
            <ListRow
              key={row.hostId}
              stripe={index}
              tone={
                row.error || nodesDown > 0
                  ? "destructive"
                  : row.podsFailing > 0
                    ? "warning"
                    : "success"
              }
              icon={<ShipWheel className="size-3.5" />}
              title={host?.name || host?.ip || `#${row.hostId}`}
              badges={
                row.podsFailing > 0 ? (
                  <ListBadge tone="destructive">
                    {t("card.failing", { count: row.podsFailing })}
                  </ListBadge>
                ) : undefined
              }
              meta={
                row.error ??
                t("card.counts", {
                  ready: row.nodesReady,
                  nodes: row.nodesTotal,
                  running: row.podsRunning,
                  pods: row.podsTotal,
                })
              }
              onClick={() => host && tabs.openTab(host, "kubernetes")}
            />
          );
        })}
      </PanelList>
    </div>
  );
}
