#!/usr/bin/env python3
"""Use a private fixture to reject a stroke crossing another same-app window."""
import json
import os
import pathlib
import subprocess
import tempfile
import time
ROOT = pathlib.Path(__file__).resolve().parents[2]
CU = pathlib.Path(os.environ.get('CU_BIN', ROOT / 'bin' / 'cu'))
with tempfile.TemporaryDirectory(prefix='cu-paint-obstruction-') as state:
    env = {**os.environ, 'CU_STATE_DIR': state, 'CU_NO_USER_PAUSE': '1'}
    fixture = pathlib.Path(state) / 'fixture'
    subprocess.run(['swiftc', '-framework', 'AppKit', str(ROOT / 'engine/tests/fixtures/paint_occlusion.swift'), '-o', str(fixture)], check=True, timeout=60)
    foreign = None
    cursor = None
    if os.environ.get('CU_FOREIGN') == '1' or os.environ.get('CU_CURSOR') == '1' or os.environ.get('CU_GEOMETRY') == '1': env['CU_NO_PANEL'] = '1'
    app = subprocess.Popen([str(fixture)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.environ.get('CU_CURSOR') == '1':
        cursor = subprocess.Popen([str(CU), 'cursor-overlay'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        time.sleep(.5)
    if os.environ.get('CU_FOREIGN') == '1':
        foreign_bin = pathlib.Path(state) / 'foreign'
        subprocess.run(['swiftc', '-framework', 'AppKit', str(ROOT / 'engine/tests/fixtures/foreign_paint_panel.swift'), '-o', str(foreign_bin)], check=True, timeout=60)
        foreign = subprocess.Popen([str(foreign_bin)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
    try:
        until = time.monotonic() + 10
        while True:
            result = json.loads(subprocess.check_output([str(CU), 'windows', '--pid', str(app.pid)], env=env))
            own = [w for w in result.get('windows', []) if w['pid'] == app.pid]
            target = next((w for w in own if w.get('title') == 'CU Paint Target' and w.get('windowId', 0) > 0), None)
            popup = next((w for w in own if w.get('title') == 'CU Paint Obstacle'), None)
            if target and (popup or os.environ.get('CU_PANEL') == '1' or foreign or cursor or os.environ.get('CU_GEOMETRY') == '1'): break
            if time.monotonic() > until: raise RuntimeError(f'fixture windows missing: {own}, exit={app.poll()}')
            time.sleep(.1)
        p = popup['bounds'] if popup else {'x': target['bounds']['x'] + 180, 'y': target['bounds']['y'] + 120, 'width': 140, 'height': 120}
        y = p['y'] + p['height'] / 2
        path = pathlib.Path(state) / 'stroke.json'
        path.write_text(json.dumps({'strokes': [[[p['x'] - 15, y], [p['x'] + p['width'] + 15, y]]]}))
        args = [str(CU), 'strokes', '--pid', str(app.pid), '--window', str(target['windowId']), '--background', '--file', str(path)]
        if foreign: args += ['--cursor-overlay-pid', str(foreign.pid)]
        if cursor: args += ['--cursor-overlay-pid', str(cursor.pid)]
        if os.environ.get('CU_GEOMETRY') == '1': args += ['--expected-window', '0,0,1,1']
        proc = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        if os.environ.get('CU_GEOMETRY') == '1':
            assert payload.get('error') == 'window_geometry_changed', payload
            print('stale drawing geometry test passed')
        elif cursor:
            assert payload.get('ok') is True, payload
            print('own cursor overlay passthrough test passed')
        else:
            assert payload.get('error') == 'stroke_obstructed', payload
            print('window obstruction test passed')
    finally:
        if cursor and cursor.poll() is None:
            cursor.stdin.close()
            try: cursor.wait(timeout=3)
            except subprocess.TimeoutExpired: cursor.terminate(); cursor.wait()
        if foreign and foreign.poll() is None:
            foreign.terminate()
            try: foreign.wait(timeout=3)
            except subprocess.TimeoutExpired: foreign.kill(); foreign.wait()
        app.terminate()
        try: app.wait(timeout=3)
        except subprocess.TimeoutExpired: app.kill(); app.wait()
