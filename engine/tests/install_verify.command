#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
exec > tests/install_verify.log 2>&1
printf 'Installing: '; date
bash install-app.sh
cmp mcp/server.py "$HOME/Library/Application Support/cu/mcp/server.py"
echo 'MCP_COPY_MATCH=YES'
bash tests/run_all.sh --quick
for attempt in {1..30}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:47777/v1/status > tests/install_status.json; then
        cat tests/install_status.json
        echo
        echo 'INSTALL_VERIFIED=YES'
        exit 0
    fi
    sleep 1
done
echo 'INSTALL_VERIFIED=NO: service did not answer' >&2
exit 1
