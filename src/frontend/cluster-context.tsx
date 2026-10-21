import React from "react";
import type { DetailTab } from "./kinds";
import type { KubeHost, KubeValidation, ResourceRef } from "./types";

export interface ClusterValue {
  sessionId: string;
  host: KubeHost;
  validation: KubeValidation;
  /** The kubeconfig context picked in the header, if not the default. */
  context?: string;
  readOnly: boolean;
  compact: boolean;
  /** Opens a resource's detail view, on a tab when given. */
  open: (ref: ResourceRef, tab?: DetailTab) => void;
}

const ClusterContext = React.createContext<ClusterValue | null>(null);

export const ClusterProvider = ClusterContext.Provider;

export function useCluster(): ClusterValue {
  const value = React.useContext(ClusterContext);
  if (!value) throw new Error("useCluster needs a ClusterProvider");
  return value;
}
