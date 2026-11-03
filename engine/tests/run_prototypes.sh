#!/bin/bash
# Compile and run isolated Swift prototype tests without modifying the installed CU.
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/cu-prototypes.XXXXXXXX")
trap 'rm -rf "$test_dir"' EXIT

swiftc -swift-version 6 -strict-concurrency=complete \
    Sources/ControlLease.swift tests/lease_tests.swift -o "$test_dir/lease_tests"
"$test_dir/lease_tests"
swiftc -swift-version 6 -strict-concurrency=complete \
    Sources/ProcessSupervisor.swift tests/process_supervisor_tests.swift -o "$test_dir/process_supervisor_tests"
"$test_dir/process_supervisor_tests"
