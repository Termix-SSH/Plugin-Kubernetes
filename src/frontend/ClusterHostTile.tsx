import { useCallback, useEffect, useState } from "react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { StatTile, TileWall } from "@termix-ssh/plugin-sdk/ui";
import type { ClusterSummary } from "./ClustersCard";

const POLL_MS = 60_000;

/** Node and pod health of one cluster, on the host page. */
export function ClusterHostTile({
  hostId,
  isVisible = true,
}: {
  hostId: number;
  isVisible?: boolean;
}) {
  const { t } = useTranslation();
  const allowed = usePermission("use");
  const api = usePluginApi();
  const [row, setRow] = useState<ClusterSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<ClusterSummary[]>("/summary", {
        params: { hostId },
      });
      setRow(data[0] ?? null);
    } catch {
      setRow(null);
    }
  }, [api, hostId]);

  useEffect(() => {
    if (!isVisible || !allowed) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, allowed, load]);

  if (!allowed) return null;
  if (!row || row.error) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("tile.empty")}</p>
    );
  }
  return (
    <TileWall size="3">
      <StatTile
        label={t("tile.nodes")}
        value={`${row.nodesReady}/${row.nodesTotal}`}
        tone={row.nodesReady < row.nodesTotal ? "warn" : "default"}
      />
      <StatTile
        label={t("tile.pods")}
        value={`${row.podsRunning}/${row.podsTotal}`}
      />
      <StatTile
        label={t("tile.failing")}
        value={String(row.podsFailing)}
        tone={row.podsFailing > 0 ? "warn" : "default"}
      />
    </TileWall>
  );
}
