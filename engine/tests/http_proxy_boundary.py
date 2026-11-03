#!/usr/bin/env python3
"""Compile the actual pure HTTP routing guard, without starting a service."""
import pathlib, subprocess, tempfile
root=pathlib.Path(__file__).resolve().parents[1]
source=(root/'Sources/main.swift').read_text()
start=source.index('func requiresMCPProxy(')
end=source.index('\nfunc ', start+1)
guard=source[start:end]
checks='''
assert(requiresMCPProxy("expect", ["count": 2]))
assert(requiresMCPProxy("expect", ["role": "AXButton"]))
assert(!requiresMCPProxy("expect", ["pid": 17, "query": "clip"]))
assert(requiresMCPProxy("batch", ["timeoutMs": 1]))
assert(requiresMCPProxy("batch", ["steps": [["tool": "cursor_position", "arguments": [:]], ["tool": "expect", "arguments": ["count": 2]]]]))
assert(!requiresMCPProxy("batch", ["steps": [["tool": "expect", "arguments": ["pid": 17, "query": "clip"]]]]))
print("HTTP proxy-only argument guard: 6 checks passed")
'''
with tempfile.TemporaryDirectory(prefix='cu-http-guard-') as temp:
    file=pathlib.Path(temp)/'main.swift'
    file.write_text('import Foundation\n'+guard+checks)
    binary=pathlib.Path(temp)/'guard'
    subprocess.run(['swiftc',str(file),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
