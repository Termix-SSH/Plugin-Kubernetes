import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

export interface HostProblem {
  /** Stable per problem, so a repeat is not sent twice. */
  key: string;
  title: string;
  body?: string;
  severity?: "warning" | "critical";
}

export interface HostAlertsOptions {
  ctx: PluginContext;
  /** Host setting that turns the alerts on. Off unless the host sets it. */
  setting: string;
  /** Alert category, "<pluginId>.<kind>". */
  category: string;
  /** Tab the alert opens. */
  tab: string;
  intervalMs?: number;
  /** Current problems on a host. Runs as the user who turned the alerts on. */
  probe: (hostId: number) => Promise<HostProblem[]>;
}

const PREFIX = "alerts:";
const DEFAULT_INTERVAL_MS = 120_000;

/**
 * Alerts for hosts that opted in with a host setting. The user who saves the
 * setting is remembered, and each check runs as them.
 */
export function startHostAlerts(options: HostAlertsOptions): {
  tick: () => Promise<void>;
} {
  const { ctx, setting, category, tab, probe } = options;
  const known = new Map<number, Set<string>>();
  let busy = false;

  ctx.settings.onValidate("host", async (values, { hostId }) => {
    if (!hostId || !(setting in values)) return;
    if (values[setting] === true) {
      const actor = ctx.currentActor();
      if (actor) await ctx.kv.set(`${PREFIX}${hostId}`, actor);
    } else {
      await ctx.kv.delete(`${PREFIX}${hostId}`);
      known.delete(hostId);
    }
  });

  const forget = async (hostId: number) => {
    known.delete(hostId);
    await ctx.kv.delete(`${PREFIX}${hostId}`);
  };

  const check = async (hostId: number, owner: string) => {
    const access = await ctx.hosts.checkAccess(hostId, "connect");
    if (!access.hasAccess) return forget(hostId);
    const values = await ctx.settings.getAll("host", hostId);
    if (values[setting] !== true) return forget(hostId);

    const problems = await probe(hostId);
    const seen = known.get(hostId) ?? new Set<string>();
    const name =
      (await ctx.hosts.list()).find((host) => host.id === hostId)?.name ??
      `#${hostId}`;
    for (const problem of problems) {
      if (seen.has(problem.key)) continue;
      await ctx.notify.send({
        title: problem.title,
        body: problem.body ? `${name}: ${problem.body}` : name,
        severity: problem.severity ?? "warning",
        category,
        audience: { userId: owner },
        link: { tab },
        dedupeKey: `${category}:${hostId}:${problem.key}`,
        context: { hostId, hostName: name },
      });
    }
    known.set(hostId, new Set(problems.map((problem) => problem.key)));
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const key of await ctx.kv.list()) {
        if (!key.startsWith(PREFIX)) continue;
        const hostId = Number(key.slice(PREFIX.length));
        const owner = await ctx.kv.get(key);
        if (!Number.isInteger(hostId) || typeof owner !== "string") continue;
        try {
          await ctx.asUser(owner, () => check(hostId, owner));
        } catch (error) {
          ctx.log.debug(
            `Alert check failed for host ${hostId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      busy = false;
    }
  };

  ctx.schedule.every(options.intervalMs ?? DEFAULT_INTERVAL_MS, tick, {
    jitterMs: 5_000,
  });
  return { tick };
}
