# fleet-health

Cross-cutting health check for every `swamp-workflow-*` timer on this
host, spanning both Grafana dashboards (`fun-stuff` and
`rpi-metrics-bridge`). Like `rpi-workflows`, this repo publishes no
extension of its own — it pulls already-published extensions and a small
local Loki-query model, then asserts across them.

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
- Five of the fifteen monitored units (`iss-tracker`,
  `can-i-hang-my-washing-out`, `package-archaeology`,
  `github-trending`, `rpi-metrics-bridge`) run their service via a
  wrapper script calling `swamp model method run` directly rather than
  `swamp workflow run`, so they never print a workflow-shaped journal
  line at all — `lastRunStatus` was permanently `"unknown"` for all five,
  regardless of real outcome. `systemd-panel` now falls back to
  `systemctl show`'s own exit-state for a unit whose journal has nothing
  recognizable, since that's set by systemd from the real exit code
  independent of what the process printed. Fixed in `2026.10.01.3`.

**Known residual gap:** `rpi-metrics-bridge` still reports `"unknown"`
even with the fallback — its per-run logging is verbose enough that the
actual completion line sometimes falls outside the 40-line journal tail
`systemd-panel` reads, and `systemctl show`'s `ActiveState` on a
once-a-minute oneshot can catch it mid-run rather than freshly exited.
This fails safe (reported as indeterminate, not wrongly "healthy") —
worth another look if it matters, not fixed here.

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
# @aaronge/fleet-health-loki is a local model in this repo — no pull needed

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

## License

MIT — see LICENSE for details.
