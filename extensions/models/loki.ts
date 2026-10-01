/**
 * Evidence-preserving instant LogQL queries against Loki, mirroring
 * `@dieter/prometheus`'s design: an explicit `time` argument rather than
 * an implicit "now", so a captured result is reproducible and auditable.
 * Built for `count_over_time(...)`-style queries that answer "how many
 * matching log lines in this window" without pulling the lines
 * themselves — the shape a health check needs, not a log browser.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Global arguments: the Loki instance to query. */
const GlobalArgsSchema = z.object({
  baseUrl: z.string().url().describe(
    "Loki base URL, e.g. http://localhost:3100",
  ),
  timeoutSeconds: z.number().int().positive().default(30),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Per-run arguments for an instant LogQL query. */
const QueryArgsSchema = z.object({
  logql: z.string().min(1).describe(
    "Full LogQL expression, e.g. " +
      '\'count_over_time({family=~"fun|core"} |~ "(?i)error|failed" [1h])\'. ' +
      "Must return a vector/scalar (an instant query), not raw log lines.",
  ),
  time: z.string().min(1).describe(
    "RFC3339 or Unix-nanosecond timestamp to evaluate at. No implicit " +
      '"now" — pass an explicit, reproducible timestamp.',
  ),
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,127}$/).describe(
    "Instance name this result is stored under (lowercase, digits, hyphens, underscores).",
  ),
});

/** Stored query result: the parsed vector plus a total across all series. */
const QueryResultSchema = z.object({
  logql: z.string(),
  requestedAt: z.iso.datetime(),
  time: z.string(),
  httpStatus: z.number().int(),
  status: z.enum(["success", "error"]),
  totalCount: z.number().describe(
    "Sum of every returned series' value — for a count_over_time query " +
      "with no grouping this is just the one number; with grouping " +
      "labels it's the total across all of them.",
  ),
  series: z.array(z.object({
    labels: z.record(z.string(), z.string()),
    value: z.number(),
  })),
  error: z.string().nullable(),
});

/** Minimal shape of Loki's `/loki/api/v1/query` response this module reads. */
interface LokiQueryResponse {
  status: "success" | "error";
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
  error?: string;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Model definition for evidence-preserving instant Loki queries. */
export const model = {
  type: "@aaronge/fleet-health-loki",
  version: "2026.10.01.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "queryResult": {
      description: "Parsed result of an instant LogQL query",
      schema: QueryResultSchema,
      lifetime: "7d",
      garbageCollection: 100,
    },
  },
  methods: {
    "query-at": {
      description: "Evaluate a LogQL expression at an explicit timestamp",
      arguments: QueryArgsSchema,
      execute: async (
        args: z.infer<typeof QueryArgsSchema> & { _fetch?: typeof fetch },
        context: MethodContext,
      ) => {
        const fetchImpl = args._fetch ?? fetch;
        const requestedAt = new Date().toISOString();

        context.logger.info("Querying Loki: {logql} at {time}", {
          logql: args.logql,
          time: args.time,
        });

        const url = new URL("/loki/api/v1/query", context.globalArgs.baseUrl);
        url.searchParams.set("query", args.logql);
        url.searchParams.set("time", args.time);

        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          context.globalArgs.timeoutSeconds * 1000,
        );
        let httpStatus: number;
        let body: string;
        try {
          const response = await fetchImpl(url.toString(), {
            signal: controller.signal,
          });
          httpStatus = response.status;
          body = await response.text();
        } finally {
          clearTimeout(timeout);
        }

        const parsed = JSON.parse(body) as LokiQueryResponse;
        const series = (parsed.data?.result ?? []).map((r) => ({
          labels: r.metric,
          value: Number(r.value[1]),
        }));
        const totalCount = series.reduce((sum, s) => sum + s.value, 0);

        context.logger.info(
          "Loki query {name}: {totalCount} total across {seriesCount} series",
          { name: args.name, totalCount, seriesCount: series.length },
        );

        const handle = await context.writeResource("queryResult", args.name, {
          logql: args.logql,
          requestedAt,
          time: args.time,
          httpStatus,
          status: parsed.status,
          totalCount,
          series,
          error: parsed.error ?? null,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
