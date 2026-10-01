import { assert, assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import { model } from "./loki.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const globalArgs = { baseUrl: "http://localhost:3100", timeoutSeconds: 30 };

Deno.test("query-at sums a single ungrouped series into totalCount", async () => {
  const stubFetch = (() =>
    Promise.resolve(jsonResponse({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: {}, value: [1790000000, "8"] }],
      },
    }))) as unknown as typeof fetch;

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "query-at",
  });

  await model.methods["query-at"].execute(
    {
      logql: 'count_over_time({family="fun"} |= "error" [1h])',
      time: "2026-10-01T09:00:00Z",
      name: "fun-errors",
      _fetch: stubFetch,
    },
    context as never,
  );

  const [written] = getWrittenResources();
  assertEquals(written.specName, "queryResult");
  assertEquals(written.data.totalCount, 8);
  assertEquals((written.data.series as unknown[]).length, 1);
});

Deno.test("query-at sums multiple grouped series into one totalCount", async () => {
  const stubFetch = (() =>
    Promise.resolve(jsonResponse({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { unit: "iss-tracker.service" }, value: [1790000000, "3"] },
          {
            metric: { unit: "rpi-metrics-bridge.service" },
            value: [1790000000, "500"],
          },
        ],
      },
    }))) as unknown as typeof fetch;

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "query-at",
  });

  await model.methods["query-at"].execute(
    {
      logql: "count_over_time(...)",
      time: "2026-10-01T09:00:00Z",
      name: "grouped",
      _fetch: stubFetch,
    },
    context as never,
  );

  const [written] = getWrittenResources();
  assertEquals(written.data.totalCount, 503);
  assertEquals((written.data.series as unknown[]).length, 2);
});

Deno.test("query-at returns totalCount 0 for an empty result (nothing matched)", async () => {
  const stubFetch = (() =>
    Promise.resolve(jsonResponse({
      status: "success",
      data: { resultType: "vector", result: [] },
    }))) as unknown as typeof fetch;

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "query-at",
  });

  await model.methods["query-at"].execute(
    {
      logql: 'count_over_time({family="fun"} |= "nonexistent-string" [1h])',
      time: "2026-10-01T09:00:00Z",
      name: "empty",
      _fetch: stubFetch,
    },
    context as never,
  );

  const [written] = getWrittenResources();
  assertEquals(written.data.totalCount, 0);
  assertEquals((written.data.series as unknown[]).length, 0);
});

Deno.test("query-at records a Loki-side error without throwing", async () => {
  const stubFetch = (() =>
    Promise.resolve(jsonResponse({
      status: "error",
      error: "parse error: unexpected IDENTIFIER",
    }, 400))) as unknown as typeof fetch;

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "query-at",
  });

  await model.methods["query-at"].execute(
    {
      logql: "not valid logql(((",
      time: "2026-10-01T09:00:00Z",
      name: "bad-query",
      _fetch: stubFetch,
    },
    context as never,
  );

  const [written] = getWrittenResources();
  assertEquals(written.data.status, "error");
  assertEquals(written.data.httpStatus, 400);
  assert((written.data.error as string).includes("parse error"));
});

Deno.test("query-at passes query and time as URL search params", async () => {
  let capturedUrl: URL | undefined;
  const stubFetch = ((url: string | URL) => {
    capturedUrl = new URL(String(url));
    return Promise.resolve(jsonResponse({
      status: "success",
      data: { resultType: "vector", result: [] },
    }));
  }) as unknown as typeof fetch;

  const { context } = createModelTestContext({
    globalArgs,
    methodName: "query-at",
  });

  await model.methods["query-at"].execute(
    {
      logql: 'count_over_time({family="core"}[5m])',
      time: "2026-10-01T09:30:00Z",
      name: "params-check",
      _fetch: stubFetch,
    },
    context as never,
  );

  assert(capturedUrl);
  assertEquals(capturedUrl!.pathname, "/loki/api/v1/query");
  assertEquals(
    capturedUrl!.searchParams.get("query"),
    'count_over_time({family="core"}[5m])',
  );
  assertEquals(capturedUrl!.searchParams.get("time"), "2026-10-01T09:30:00Z");
});
