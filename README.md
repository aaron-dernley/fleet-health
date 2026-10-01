# fleet-health

Cross-cutting health check for every `swamp-workflow-*` timer on this
host, spanning both Grafana dashboards (`fun-stuff` and
`rpi-metrics-bridge`). Like `rpi-workflows`, most of what's here is
host-specific glue — pulled extensions and one-instance-per-unit model
configs, not meant to be reused elsewhere. The one exception is
`@aaronge/fleet-health-loki` (see
[below](#aaronge-fleet-health-loki-published-extension)), a small,
general-purpose Loki-query model published to the swamp registry in its
own right.

## What it checks

1. **Each unit's own last-run outcome**, via `@aaronge/systemd-panel`
   (one instance per unit — see `models/`). Restarts anything found in a
   failed state. **This only helps transient failures** — a unit failing
   from a persistent external cause (a hardware fault, a port held by an
   unrelated process) just re-fails identically after restart. It is not
   a substitute for actually fixing the underlying problem.
2. **Freshness** of every Prometheus textfile export, via
   `@dieter/prometheus`, against each export's own expected cadence.
3. **New error-level log lines** across both the `fun` and `core`
   journald/Promtail/Loki families, via the local `fleet-health-loki`
   model — deliberately excluding three already-characterized conditions
   (by `unit` label, not fragile text matching) so this surfaces **net
   new** problems rather than re-alarming on ones already visible
   elsewhere:
   - the ongoing PCIe link-degraded hardware fault
     (`rpi-workflows-link-integrity` has its own 5-minute assert for
     that already)
   - `rpi-connect`'s expected "not signed in" (explicitly non-blocking by
     its own design)
   - `iss-tracker`'s occasional `fetch failed` against Open Notify's
     public HTTP API (no SLA, self-heals on the next 5-minute retry)

   `rpi-workflows-link-integrity` is excluded from the pass/fail gate for
   the same reason (`gatedUnits` in the workflow's `inputs`) — it's still
   synced and restart-attempted via `units`, so it stays visible in the
   exported metrics, just not double-alarmed on top of its own dedicated
   check.

## A real bug this found

Building and testing this workflow against all 15 monitored units
surfaced two real, previously-undiscovered issues, both fixed upstream:

- **`@aaronge/systemd-panel`** only recognized swamp's success-case
  journal phrasing (`"Completed workflow X succeeded in Ys"`) — a
  genuine failure prints a completely different sentence (`"Failed
  workflow X in Ys"`, no "Completed" prefix at all), which the parser
  never matched. A real failure was silently reported as
  `lastRunStatus: "unknown"` instead of `"failed"`. Fixed in
  `2026.10.01.2`.
- Four of the fifteen monitored units (`iss-tracker`,
  `can-i-hang-my-washing-out`, `package-archaeology`, `github-trending`)
  run their service via a wrapper script calling `swamp model method
  run` directly rather than `swamp workflow run`, so they never print a
  workflow-shaped journal line at all — `lastRunStatus` was permanently
  `"unknown"` for all four, regardless of real outcome. `systemd-panel`
  now falls back to `systemctl show`'s own exit-state for a unit whose
  journal has nothing recognizable, since that's set by systemd from the
  real exit code independent of what the process printed. Fixed in
  `2026.10.01.3`.

**Not a bug — `rpi-metrics-bridge` intermittently shows `"unknown"` for
a genuine reason.** Unlike the four units above, it runs `swamp workflow
run metrics-export` directly (same pattern as `host-health` etc.) and
does print a recognizable completion line — but that job is currently
taking minutes per run (as long as 2m47s observed) against its own
once-a-minute schedule, a real, separate, already-tracked performance
issue in that repo (a growing debsecan vulnerability scan — see its own
README/issue tracker, not this one). `fleet-health`'s check sometimes
catches it mid-run (`systemctl show` reports `ActiveState=activating`,
no exit code yet to read), and correctly reports that as indeterminate
rather than guessing — this is the fallback behaving exactly as
designed given a real external slowdown, not a `systemd-panel` parsing
gap. It'll resolve itself once that job's own performance is fixed.

**Deliberately not done:** this workflow doesn't monitor its own
`swamp-workflow-fleet-health` unit (no recursive self-registration). If
`fleet-health` itself stops running, nothing here would catch that
directly — though the "Fleet Health Check Freshness" Grafana panel
(`node_textfile_mtime_seconds` on `fleet-health.prom` itself) would
eventually show it as stale.

## Setup

```sh
swamp extension pull @aaronge/systemd-panel
swamp extension pull @dieter/prometheus
swamp extension pull @aaronge/fleet-health-loki

swamp model create @dieter/prometheus prom \
  --global-arg baseUrl=http://localhost:9099
swamp model create @aaronge/fleet-health-loki loki \
  --global-arg baseUrl=http://localhost:3100

# One @aaronge/systemd-panel instance per monitored unit — see
# workflows/workflow-fleet-health.yaml's `inputs.units` default for the
# full list. Pattern:
swamp model create @aaronge/systemd-panel unit-<name> \
  --global-arg unit=swamp-workflow-<name>.timer \
  --global-arg logUnit=swamp-workflow-<name>.service \
  --global-arg kind=timer \
  --global-arg label=<name>
```

Run by hand with `swamp workflow run fleet-health`, or see
[Scheduling](#scheduling) for the production timer.

## Scheduling

Same pattern as every other extension in this family: an ephemeral
`swamp serve` per run, started by a `systemd.timer`, rather than a
persistent daemon (see the other repos' READMEs for why — roughly
400MB idle RSS per persistent `swamp serve` adds up fast on an 8GB Pi).
`run-via-serve.sh` runs the workflow, then exports the result as a
Prometheus textfile (`fleet-health.prom`) for the `rpi-metrics-bridge`
Grafana dashboard's "Fleet Health" row.

The two systemd unit files aren't checked into this repo — host config,
created directly on the machine that runs the schedule, same as the
sibling extensions:

- `swamp-workflow-fleet-health.service` — a `oneshot` running
  `run-via-serve.sh` as the owning user.
- `swamp-workflow-fleet-health.timer` — `OnCalendar=*:08,18,28,38,48,58:00`
  (every 10 minutes, offset clear of the 5-minute family's `:00`-`:02`
  cluster), `Persistent=true`, `WantedBy=timers.target`.

`sudo systemctl enable --now swamp-workflow-fleet-health.timer` after
creating both.

## Grafana

Exports five metrics via `fleet-health.prom`:

| Metric | Meaning |
| --- | --- |
| `fleet_health_unit_up{unit="..."}` | 1 if the unit's last recognized run succeeded, 0 if failed. Absent (not 0) when the outcome couldn't be determined. |
| `fleet_health_units_monitored` / `fleet_health_units_total` | How many of the 15 units currently have a trustworthy signal. |
| `fleet_health_stale_exports` | Count of textfile exports beyond their own freshness window. |
| `fleet_health_new_errors` | Net-new error-level log lines in the last 10 minutes (see exclusions above). |

Added to the `rpi-metrics-bridge` dashboard (not `fun-stuff`) since this
is fundamentally an ops/infra artifact — a "Fleet Health" row with
Units Monitored, Stale Exports, New Errors, a freshness stat for
`fleet-health.prom` itself, and a per-unit status table.

## @aaronge/fleet-health-loki (published extension)

Evidence-preserving instant [LogQL](https://grafana.com/docs/loki/latest/query/)
queries against [Loki](https://grafana.com/oss/loki/), mirroring
[`@dieter/prometheus`](https://github.com/Dieterbe/swamp-prometheus)'s
design: an explicit `time` argument rather than an implicit "now", so a
captured result is reproducible and auditable. Built for
`count_over_time(...)`-style queries that answer "how many matching log
lines in this window" without pulling the lines themselves — the shape
a health check needs, not a log browser. This is the one piece of this
repo meant for reuse outside it; everything else above is specific to
this host's own fleet.

### Installation

```sh
swamp extension pull @aaronge/fleet-health-loki
```

### Usage

```sh
swamp model create @aaronge/fleet-health-loki loki \
  --global-arg baseUrl=http://localhost:3100

swamp model method run loki query-at \
  --input logql='count_over_time({job="myapp"} |= "error" [1h])' \
  --input time=2026-10-01T09:00:00Z \
  --input name=myapp-errors

swamp model output get loki --json
```

`time` takes an RFC3339 or Unix timestamp — never "now" — so two runs
with the same `time` produce the same result, and the query that was
actually evaluated (including the exact timestamp) is preserved
alongside the answer. `name` must be lowercase letters/digits/hyphens/
underscores — it's the instance name this particular query's result is
stored under, so running several different checks against the same
`loki` model instance keeps each one's history separate.

### Global arguments

| Arg              | Default      | Notes                              |
| ----------------- | ------------ | ----------------------------------- |
| `baseUrl`         | _(required)_ | Loki base URL, e.g. `http://localhost:3100`. |
| `timeoutSeconds`  | `30`         | Request timeout.                    |

### How it works

The `query-at` method sends `logql` and `time` to Loki's
`/loki/api/v1/query` instant-query endpoint (not `/query_range` — this
model is for aggregate counts, not browsing raw lines) and stores the
parsed result: each returned series' labels and value, plus
`totalCount` (the sum across every series — for an ungrouped query
that's just the one number; for a query with grouping labels it's the
total across all of them). A Loki-side query error (bad LogQL, timeout)
is recorded in the result rather than thrown, so a workflow can assert
on `status == "error"` explicitly instead of the step just failing
outright with no detail.

## License

MIT — see LICENSE for details.
