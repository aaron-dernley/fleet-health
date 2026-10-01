#!/bin/bash
# Starts swamp serve just long enough to run the fleet-health workflow,
# then tears it down — avoids the ~400MB idle RSS cost of a persistent
# swamp serve daemon (see the other fun-stuff/rpi-workflows extensions
# for why that matters on this 8GB Pi) while still going through swamp
# serve as requested.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9097

# Each swamp call's JSON goes to its own temp file rather than through a
# shell variable embedded in a Python string literal — avoids any
# quoting/escaping hazard from values swamp's own output might contain.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$REPO_DIR"
swamp serve --repo-dir "$REPO_DIR" --port "$PORT" --host 127.0.0.1 --no-schedule --no-telemetry \
  >/tmp/fleet-health-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Deliberately not `set -e` around this: the workflow is EXPECTED to
# exit non-zero whenever it finds something wrong (that's the whole
# point of its assert job) — a failed run still needs the export step
# below to run so the Grafana panel reflects what it found.
swamp workflow run fleet-health --server "ws://127.0.0.1:${PORT}"

# Export a small Prometheus textfile snippet for the RPi Metrics Bridge
# Grafana dashboard's "Fleet Health" row. Written atomically (tmp file +
# mv) since node_exporter may be scraping the textfile directory
# concurrently.
PROM_DIR=/var/lib/prometheus/node-exporter
PROM_TMP="$(mktemp "${PROM_DIR}/.fleet-health.prom.XXXXXX")"

swamp data query 'modelType == "@aaronge/systemd-panel" && specName == "status"' \
  --select '{"label": attributes.label, "lastRunStatus": attributes.lastRunStatus, "lastRunRecognized": attributes.lastRunRecognized}' \
  --server "ws://127.0.0.1:${PORT}" --json > "${WORKDIR}/units.json"
swamp data get prom freshness --server "ws://127.0.0.1:${PORT}" --json > "${WORKDIR}/freshness.json"
swamp data get loki new-errors --server "ws://127.0.0.1:${PORT}" --json > "${WORKDIR}/errors.json"

python3 -c "
import json, sys

with open(sys.argv[1]) as f:
    units = json.load(f)['results']
with open(sys.argv[2]) as f:
    freshness = json.load(f)['content']
with open(sys.argv[3]) as f:
    errors = json.load(f)['content']

print('# HELP fleet_health_unit_up 1 if the unit\'s last recognized run succeeded, 0 if it failed. Absent (not 0) when the unit\'s outcome could not be determined at all.')
print('# TYPE fleet_health_unit_up gauge')
for u in units:
    if not u['lastRunRecognized']:
        continue
    up = 1 if u['lastRunStatus'] == 'succeeded' else 0
    label = u['label'].replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"')
    print(f'fleet_health_unit_up{{unit=\"{label}\"}} {up}')

recognized_count = sum(1 for u in units if u['lastRunRecognized'])
print('# HELP fleet_health_units_monitored Total units with a trustworthy pass/fail signal, out of the total checked.')
print('# TYPE fleet_health_units_monitored gauge')
print(f'fleet_health_units_monitored {recognized_count}')
print(f'fleet_health_units_total {len(units)}')

stale_count = len(freshness.get('data', {}).get('result', []))
print('# HELP fleet_health_stale_exports Number of Prometheus textfile exports currently beyond their expected freshness window.')
print('# TYPE fleet_health_stale_exports gauge')
print(f'fleet_health_stale_exports {stale_count}')

print('# HELP fleet_health_new_errors New error-level log lines in the last 10 minutes, excluding already-tracked baseline noise (PCIe, rpi-connect, iss-tracker flaky fetch).')
print('# TYPE fleet_health_new_errors gauge')
print(f'fleet_health_new_errors {errors[\"totalCount\"]}')
" "${WORKDIR}/units.json" "${WORKDIR}/freshness.json" "${WORKDIR}/errors.json" > "$PROM_TMP"
chmod 644 "$PROM_TMP"
mv "$PROM_TMP" "${PROM_DIR}/fleet-health.prom"
