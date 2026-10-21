import {
  ConnectionScreen,
  FullScreenAppWrapper,
} from "@termix-ssh/plugin-sdk/ui";
import React from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { KubernetesManager } from "./KubernetesManager.tsx";
import { toKubeHost, type KubeHostSource } from "./types";

interface KubernetesAppProps {
  hostId?: string;
}

const KubernetesApp: React.FC<KubernetesAppProps> = ({ hostId }) => {
  const { t } = useTranslation();
  return (
    <FullScreenAppWrapper hostId={hostId}>
      {(hostConfig, phase) => {
        if (phase === "loading") {
          return (
            <div className="relative h-full w-full">
              <ConnectionScreen
                status="connecting"
                message={t("hosts.loadingHost")}
              />
            </div>
          );
        }

        if (!hostConfig) {
          return (
            <div className="relative h-full w-full">
              <ConnectionScreen
                status="error"
                unavailable={{ title: t("hosts.hostNotFound") }}
              />
            </div>
          );
        }

        return (
          <KubernetesManager
            host={toKubeHost(hostConfig as unknown as KubeHostSource)}
            title={hostConfig.name || `${hostConfig.username}@${hostConfig.ip}`}
            isVisible={true}
            isTopbarOpen={false}
            embedded={true}
            onClose={() => {}}
          />
        );
      }}
    </FullScreenAppWrapper>
  );
};

export default KubernetesApp;
