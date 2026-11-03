#!/bin/bash
# Run from an existing shell; this runner never opens Terminal windows.
# --quick checks MCP logic only, without rebuilding Swift or touching the UI.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tests/connection_state.py
python3 tests/batch_units.py
python3 tests/expect_count_units.py
python3 tests/observe_units.py
python3 tests/import_goto_units.py
if [ "${1:-}" = "--quick" ]; then
    python3 tests/server_units.py
    python3 tests/execution_units.py
    python3 tests/state_adapter_units.py
    python3 tests/import_flow_units.py
    python3 tests/indicator_lifecycle.py
    exit
fi
python3 tests/indicator_lifecycle.py
echo "== server units"; python3 tests/server_units.py | tail -2
echo "== import flow"; python3 tests/import_flow_units.py | tail -2
echo "== guards";      python3 tests/guards.py | tail -2
echo "== stability";   python3 tests/stability.py --rounds 10 | tail -6
echo "== background";  python3 tests/background.py --rounds 5 | tail -2
echo "== window ops";   python3 tests/window_ops.py | tail -4
echo "== deep tree";    python3 tests/deepfind.py | tail -6
echo "== widgets";      python3 tests/demo_controls.py | tail -5
echo "== chromium";    python3 tests/chromium.py --rounds 5 | tail -3
