#!/usr/bin/env python3
"""Exercise pause and disconnected-client cancellation with a private demo/service."""
import http.client
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
CU = pathlib.Path(os.environ.get('CU_BIN', ROOT / 'bin' / 'cu'))

def request(port, token, path, data=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=4)
    conn.request('POST' if data is not None else 'GET', path,
                 body=json.dumps(data) if data is not None else None,
                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    response = conn.getresponse()
    return conn, response

def main():
    with tempfile.TemporaryDirectory(prefix='cu-paint-stop-') as state:
        env = {**os.environ, 'CU_STATE_DIR': state, 'CU_NO_USER_PAUSE': '1'}
        probe = socket.socket(); probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]; probe.close()
        token = 'paint-stop-test'
        service = subprocess.Popen([str(CU), 'service', '--port', str(port), '--token', token], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        event_log = pathlib.Path(state) / 'events.log'
        env['CU_PAINT_EVENT_LOG'] = str(event_log)
        env['CU_ACCEPT_FOREGROUND'] = '1'
        fixture = pathlib.Path(state) / 'acceptance-target'
        subprocess.run(['swiftc', '-framework', 'AppKit', str(ROOT / 'engine/tests/fixtures/acceptance_target.swift'), '-o', str(fixture)], check=True, timeout=60)
        demo = subprocess.Popen([str(fixture)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            until = time.monotonic() + 10
            while True:
                try:
                    c, r = request(port, token, '/v1/status'); r.read(); c.close(); break
                except OSError:
                    if time.monotonic() > until: raise
                    time.sleep(.1)
            window = None
            while time.monotonic() < until:
                data = json.loads(subprocess.check_output([str(CU), 'windows'], env=env))
                window = next((w for w in data.get('windows', []) if w['pid'] == demo.pid and w['title'] == 'CU Acceptance Target'), None)
                if window: break
                time.sleep(.1)
            assert window, 'demo window unavailable'
            snapshot = json.loads(subprocess.check_output([str(CU), 'snapshot', '--pid', str(demo.pid), '--window', str(window['windowId'])], env=env))
            canvas = next((n for n in snapshot.get('nodes', []) if n.get('title') == 'Canvas Surface'), None)
            assert canvas, snapshot
            x = canvas['x'] + 20; y = canvas['y'] + canvas['h'] / 2
            stroke = pathlib.Path(state) / 'stroke.json'
            stroke.write_text(json.dumps({'strokes': [[[x, y], [x + 240, y]]]}))
            body = {'argv': ['strokes', '--pid', str(demo.pid), '--window', str(window['windowId']), '--file', str(stroke), '--pace', '100'],
                    'eventsVersion': 1, 'eventContext': {'sessionId': 'test', 'actionId': 'stroke'}}
            def start():
                c, r = request(port, token, '/v1/exec', body)
                assert r.status == 200
                pointer_count = 0
                while True:
                    line = r.readline()
                    assert line, 'stroke stream ended before a pointer event'
                    frame = json.loads(line)
                    if frame.get('event', {}).get('phase') == 'pointer':
                        pointer_count += 1
                        if pointer_count == 2: return c, r
            c, r = start()
            pause_c, pause = request(port, token, '/v1/pause', {})
            assert json.loads(pause.read())['paused']; pause_c.close()
            tail = [json.loads(line) for line in r if line.strip()]
            result = next((x['result'] for x in tail if x.get('kind') == 'result'), {})
            assert result.get('error') in ('paint_interrupted', 'paused_by_user'), result
            assert result.get('error') == 'paint_interrupted' and 'released' in result.get('message', ''), result
            until_events = time.monotonic() + 2
            while time.monotonic() < until_events and (not event_log.exists() or 'up' not in event_log.read_text()): time.sleep(.05)
            events = event_log.read_text().splitlines() if event_log.exists() else []
            assert 'down' in events and 'up' in events and events.index('down') < events.index('up'), events
            c.close()
            resume_c, resume = request(port, token, '/v1/resume', {}); resume.read(); resume_c.close()
            event_log.write_text('')
            c, r = start()
            response_socket = r.fp.raw._sock
            response_socket.shutdown(socket.SHUT_RDWR); c.close(); r.close()
            started = time.monotonic()
            q, qr = request(port, token, '/v1/exec', {'argv': ['frontmost']})
            assert json.loads(qr.read()).get('ok'); q.close()
            assert time.monotonic() - started < 3, 'disconnected stroke kept the action queue busy'
            until_events = time.monotonic() + 2
            while time.monotonic() < until_events and 'up' not in event_log.read_text(): time.sleep(.05)
            events = event_log.read_text().splitlines()
            assert 'down' in events and 'up' in events and events.index('down') < events.index('up'), events
            print('paint service stop and disconnect tests passed')
        finally:
            for proc in (service, demo):
                if proc.poll() is None:
                    proc.terminate()
                    try: proc.wait(timeout=3)
                    except subprocess.TimeoutExpired: proc.kill(); proc.wait()

if __name__ == '__main__': main()
