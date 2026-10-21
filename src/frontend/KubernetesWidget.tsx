import { ShipWheel } from "lucide-react";
import { useHost, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { WidgetTitle } from "@termix-ssh/plugin-sdk/ui";
import { KubernetesWidgetEditForm } from "./KubernetesWidgetEditForm";
import { KubernetesManager } from "./KubernetesManager";
import {
  GRID_SIZE,
  type KubernetesWidgetConfig,
  type WidgetComponentProps,
  type WidgetDefinition,
} from "./homepage";
import { kubernetesEnabled, hostTitle, toKubeHost } from "./types";

function KubernetesWidget({
  widget,
  config,
}: WidgetComponentProps<KubernetesWidgetConfig>) {
  const { t } = useTranslation();
  const record = useHost(config.hostId || undefined);

  if (!config.hostId || !record || !kubernetesEnabled(record)) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full gap-2 text-muted-foreground/60">
        <ShipWheel size={20} />
        <span className="text-xs">{t("common.noHostConfigured")}</span>
      </div>
    );
  }

  const host = toKubeHost(record);
  return (
    <div className="flex flex-col w-full h-full overflow-hidden">
      <WidgetTitle title={widget.title} icon={<ShipWheel size={11} />} />
      <div
        className="flex-1 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <KubernetesManager
          host={host}
          title={hostTitle(host)}
          isVisible={true}
          isTopbarOpen={false}
          embedded={true}
        />
      </div>
    </div>
  );
}

/** Registered by the plugin while it runs. */
export const kubernetesWidget: WidgetDefinition<KubernetesWidgetConfig> = {
  id: "kubernetes_widget",
  name: "Kubernetes",
  description: "Embedded Kubernetes cluster view for a configured host",
  category: "system",
  icon: <ShipWheel size={14} />,
  defaultConfig: { hostId: 0 },
  defaultSize: { w: GRID_SIZE * 20, h: GRID_SIZE * 14 },
  minSize: { w: GRID_SIZE * 10, h: GRID_SIZE * 8 },
  components: { view: KubernetesWidget, editForm: KubernetesWidgetEditForm },
};
