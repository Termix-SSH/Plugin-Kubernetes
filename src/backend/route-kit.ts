import type { Request, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { targetOf } from "./host-settings.js";
import { isContext, isNamespace, type KubeTarget } from "./kubectl.js";
import type { KubeSession, KubeSessions } from "./sessions.js";
import { getErrorMessage, type KubeLogger } from "./helpers.js";

export interface Deps {
  ctx: PluginContext;
  sessions: KubeSessions;
  log: KubeLogger;
}

export type RouteKit = ReturnType<typeof createRouteKit>;

/** Shared lookups and checks every route uses. */
export function createRouteKit({ ctx, sessions, log }: Deps) {
  const userOf = (res: Response): string | null => {
    const userId = ctx.currentActor();
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return userId;
  };

  /** The caller's live session for the path's sessionId, or an error reply. */
  const sessionOf = (req: Request, res: Response): KubeSession | null => {
    const userId = userOf(res);
    if (!userId) return null;
    const sessionId = String(req.params.sessionId ?? "");
    if (sessions.getPending(sessionId)) {
      res.status(400).json({
        error: "Connection pending authentication",
        code: "AUTH_PENDING",
      });
      return null;
    }
    const session = sessions.get(sessionId, userId);
    if (!session) {
      res.status(400).json({ error: "SSH session not found or not connected" });
      return null;
    }
    return session;
  };

  /** The kubectl target, with the `context` query when there is one. */
  const targetFor = (
    req: Request,
    res: Response,
    session: KubeSession,
  ): KubeTarget | null => {
    const context = req.query.context ?? req.body?.context;
    if (context === undefined || context === "") {
      return targetOf(session.settings);
    }
    if (!isContext(context)) {
      res.status(400).json({ error: "Invalid context" });
      return null;
    }
    return targetOf(session.settings, context);
  };

  /**
   * The `namespace` query: a name, or null for every namespace. Returns
   * undefined after replying when it is not a valid name.
   */
  const namespaceFor = (
    req: Request,
    res: Response,
  ): string | null | undefined => {
    const namespace = req.query.namespace ?? req.body?.namespace;
    if (namespace === undefined || namespace === "" || namespace === "_all") {
      return null;
    }
    if (!isNamespace(namespace)) {
      res.status(400).json({ error: "Invalid namespace" });
      return undefined;
    }
    return namespace;
  };

  /** False after replying when the host is read only. */
  const writable = (session: KubeSession, res: Response): boolean => {
    if (!session.settings.readOnly) return true;
    res.status(403).json({
      error: "This host is read only. Turn off Read only in Host Settings.",
      code: "READ_ONLY",
    });
    return false;
  };

  const audit = (
    req: Request,
    session: KubeSession,
    action: string,
    details: Record<string, unknown>,
    error?: unknown,
  ) =>
    void ctx.audit.record({
      action: `kubernetes_${action}`,
      resourceType: "host",
      resourceId: String(session.hostId),
      details: JSON.stringify(details),
      success: !error,
      errorMessage: error ? getErrorMessage(error) : undefined,
      request: req,
    });

  const fail = (
    res: Response,
    session: KubeSession,
    error: unknown,
    what: string,
  ) => {
    const message = getErrorMessage(error, `Failed to ${what}`);
    log.warn(`Failed to ${what}`, { hostId: session.hostId, error: message });
    if (/NotFound|not found/i.test(message)) {
      res.status(404).json({ error: message });
    } else if (/forbidden/i.test(message)) {
      res.status(403).json({ error: message, code: "FORBIDDEN" });
    } else {
      res.status(500).json({ error: message });
    }
  };

  return {
    userOf,
    sessionOf,
    targetFor,
    namespaceFor,
    writable,
    audit,
    fail,
  };
}
