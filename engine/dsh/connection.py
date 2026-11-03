"""Read-only DSH profile inspection; offline installation is deliberately disabled.

Usage: python3 -m engine.dsh.connection status --profile DIR --plugin DIR
The caller must supply both paths. No user profile is located automatically.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import tempfile
from pathlib import Path

PACKAGE = 'dsh-super-computer-use'


class ConnectionError(Exception):
    """Profile inspection or connection failed."""


class ConflictError(ConnectionError):
    """The input is invalid or an existing configuration needs review."""


class UnsupportedError(ConnectionError):
    """The requested mutation cannot yet be performed safely."""


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key: ' + key)
        result[key] = value
    return result


def _load(path):
    try:
        def invalid_constant(value):
            raise ValueError('invalid JSON constant: ' + value)
        with path.open(encoding='utf-8') as stream:
            value = json.load(stream, object_pairs_hook=_object, parse_constant=invalid_constant)
        if not isinstance(value, dict):
            raise ValueError('expected a JSON object')
        return value
    except (OSError, UnicodeError, ValueError) as exc:
        raise ConflictError(f'invalid or unreadable {path}: {exc}') from exc


def _mapping(value, label):
    if not isinstance(value, dict):
        raise ConflictError(f'{label} must be an object')
    return value


def inspect(profile, plugin):
    """Inspect explicitly supplied profile and bundle paths, without writing.

    A valid result describes configuration only; it never certifies that DSH
    resolves or starts the plugin. Existing package references are conflicts
    because their origin and ownership cannot be established here.
    """
    if not profile or not plugin:
        raise ConflictError('explicit profile and plugin paths are required')
    profile, plugin = Path(profile), Path(plugin)
    if not profile.is_absolute() or not plugin.is_absolute():
        raise ConflictError('profile and plugin paths must be absolute')
    if not profile.is_dir() or not plugin.is_dir():
        raise ConflictError('profile and plugin must be existing directories')
    manifest = _load(profile / 'package.json')
    dependencies = _mapping(manifest.get('dependencies', {}), 'dependencies')
    if any(not isinstance(value, str) or not value for value in dependencies.values()):
        raise ConflictError('dependency specifications must be nonempty strings')
    dsh = _mapping(manifest.get('dsh', {}), 'dsh')
    profile_data = _mapping(dsh.get('profile', {}), 'dsh.profile')
    bundles = profile_data.get('bundles', [])
    if not isinstance(bundles, list) or any(not isinstance(x, str) or not x for x in bundles):
        raise ConflictError('dsh.profile.bundles must be an array of nonempty strings')
    if len(bundles) != len(set(bundles)):
        raise ConflictError('dsh.profile.bundles contains duplicates')
    link = profile / 'node_modules' / PACKAGE
    if PACKAGE in dependencies or PACKAGE in bundles or os.path.lexists(link):
        raise ConflictError('existing plugin configuration or node_modules entry has unknown ownership')
def _validate_plugin(plugin):
    metadata = _load(plugin / 'package.json')
    if metadata.get('name') != PACKAGE:
        raise ConflictError('plugin package name does not match')
    bundle = _mapping(_mapping(metadata.get('dsh'), 'plugin dsh').get('bundle'), 'plugin dsh.bundle')
    patches = bundle.get('patch')
    if isinstance(patches, str):
        patches = [patches]
    if not isinstance(patches, list) or not patches or any(not isinstance(p, str) or not p for p in patches):
        raise ConflictError('plugin bundle patch must be a path or nonempty path array')
    root = plugin.resolve()
    for patch in patches:
        candidate = (root / patch).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise ConflictError('plugin patch must be an existing file within the plugin directory')


def inspect(profile, plugin):
    if not profile or not plugin:
        raise ConflictError('explicit profile and plugin paths are required')
    profile, plugin = Path(profile), Path(plugin)
    if not profile.is_absolute() or not plugin.is_absolute():
        raise ConflictError('profile and plugin paths must be absolute')
    if not profile.is_dir() or not plugin.is_dir():
        raise ConflictError('profile and plugin must be existing directories')
    manifest = _load(profile / 'package.json')
    dependencies = _mapping(manifest.get('dependencies', {}), 'dependencies')
    if any(not isinstance(value, str) or not value for value in dependencies.values()):
        raise ConflictError('dependency specifications must be nonempty strings')
    dsh = _mapping(manifest.get('dsh', {}), 'dsh')
    profile_data = _mapping(dsh.get('profile', {}), 'dsh.profile')
    bundles = profile_data.get('bundles', [])
    if not isinstance(bundles, list) or any(not isinstance(x, str) or not x for x in bundles):
        raise ConflictError('dsh.profile.bundles must be an array of nonempty strings')
    if len(bundles) != len(set(bundles)):
        raise ConflictError('dsh.profile.bundles contains duplicates')
    link = profile / 'node_modules' / PACKAGE
    if PACKAGE in dependencies or PACKAGE in bundles or os.path.lexists(link):
        raise ConflictError('existing plugin configuration or node_modules entry has unknown ownership')
    _validate_plugin(plugin)
    return {'state': 'unconfigured', 'runtime_verified': False,
            'reason': 'Offline link loading and dependency resolution have not been verified against a running DSH.'}


def connect(profile, plugin):
    profile, plugin = Path(profile), Path(plugin)
    manifest_path = profile / 'package.json'
    manifest = _load(manifest_path)
    dependencies = _mapping(manifest.get('dependencies', {}), 'dependencies')
    dsh = _mapping(manifest.get('dsh', {}), 'dsh')
    profile_data = _mapping(dsh.get('profile', {}), 'dsh.profile')
    bundles = profile_data.get('bundles', [])
    link = profile / 'node_modules' / PACKAGE

    expected_dep = 'link:' + str(plugin)
    is_wired = dependencies.get(PACKAGE) == expected_dep and PACKAGE in bundles
    is_linked = link.is_symlink() and link.readlink() == plugin

    if is_wired and is_linked:
        return {'status': 'already_connected'}

    inspect(profile, plugin)

    backup_path = profile / f'.{PACKAGE}.bak'
    if not backup_path.exists():
        backup_path.write_bytes(manifest_path.read_bytes())

    manifest['dependencies'] = dependencies
    manifest['dependencies'][PACKAGE] = expected_dep
    manifest['dsh'] = dsh
    manifest['dsh']['profile'] = profile_data
    if PACKAGE not in bundles:
        bundles.append(PACKAGE)
    manifest['dsh']['profile']['bundles'] = bundles

    link.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(link):
        link.unlink()
    link.symlink_to(plugin)

    tmp = manifest_path.with_suffix('.tmp')
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    tmp.replace(manifest_path)
    return {'status': 'connected'}


def disconnect(profile, plugin):
    profile, plugin = Path(profile), Path(plugin)
    manifest_path = profile / 'package.json'
    manifest = _load(manifest_path)
    dependencies = _mapping(manifest.get('dependencies', {}), 'dependencies')
    dsh = _mapping(manifest.get('dsh', {}), 'dsh')
    profile_data = _mapping(dsh.get('profile', {}), 'dsh.profile')
    bundles = profile_data.get('bundles', [])
    link = profile / 'node_modules' / PACKAGE

    expected_dep = 'link:' + str(plugin)
    has_dep = PACKAGE in dependencies
    has_bundle = PACKAGE in bundles
    has_link = os.path.lexists(link)

    if not has_dep and not has_bundle and not has_link:
        return {'status': 'already_disconnected'}

    if has_link and (not has_dep or not has_bundle):
        raise ConflictError('manifest changed externally while symlink exists')

    if has_dep and dependencies.get(PACKAGE) != expected_dep:
        raise ConflictError('dependency ownership mismatch')
    if has_link and (not link.is_symlink() or link.readlink() != plugin):
        raise ConflictError('symlink ownership mismatch')

    if has_dep:
        del dependencies[PACKAGE]
    if has_bundle:
        bundles.remove(PACKAGE)

    if has_link:
        link.unlink()

    backup_path = profile / f'.{PACKAGE}.bak'
    if backup_path.exists():
        backup_bytes = backup_path.read_bytes()
        try:
            backup_obj = json.loads(backup_bytes)
            if backup_obj.get('dependencies') == dependencies and backup_obj.get('dsh', {}).get('profile', {}).get('bundles') == bundles:
                tmp = manifest_path.with_suffix('.tmp')
                tmp.write_bytes(backup_bytes)
                tmp.replace(manifest_path)
                backup_path.unlink()
                return {'status': 'disconnected'}
        except Exception:
            pass

    tmp = manifest_path.with_suffix('.tmp')
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    tmp.replace(manifest_path)
    return {'status': 'disconnected'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'connect', 'disconnect'))
    parser.add_argument('--profile', required=True)
    parser.add_argument('--plugin', required=True)
    args = parser.parse_args(argv)
    try:
        result = {'status': inspect, 'connect': connect, 'disconnect': disconnect}[args.action](args.profile, args.plugin)
    except ConnectionError as exc:
        parser.exit(2, f'{type(exc).__name__}: {exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
