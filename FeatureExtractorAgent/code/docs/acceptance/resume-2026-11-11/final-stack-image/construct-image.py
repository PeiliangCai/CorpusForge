"""Reproduce this cached image; no dependency install, Next build, service or model run."""
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import hashlib, json, os, shutil, subprocess, tempfile

CODE = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent
FREEZE = CODE/'docs/acceptance/resume-2026-11-11/source-repair-freeze.json'
FREEZE_SHA = '288fa4fd3df0fe43f92f00a4c0a9a0f8fe0bf9762c6dc8430f6222d5ad002133'
BASE = 'sha256:174bf034452d4a58aa94d83b69bd670d68d23f750020afade5ed9ee0c35cfe3d'
TAG = 't1-workbench:s7-final-ui-parser-20261111'
DIST = 'build/ui-next-20261111'
BUILD_ID = '9WeI9zkvHd20Y0lBTDX5C'
ARTIFACT_MANIFEST_SHA = '8520fb671c2349ed0459374ab4caf5b7afca6632839977d1ce7b2b762b31a3d3'
SKIP_ARTIFACT_ROOTS = {'cache', 'diagnostics', 'trace', 'trace-build'}
LOCKS = ['package.json', 'package-lock.json', 'apps/pi-web/package.json',
         'apps/pi-web/package-lock.json', 'services/pdf-parser/requirements-cpu-standard.lock.txt']
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)

report = {'schema_version': 't1-final-ui-parser-image-construction-1',
          'started_at': datetime.now(timezone.utc).isoformat(),
          'status': 'preparing', 'cold_build': False,
          'method': 'Derive from an exact existing local runtime image; overlay the frozen complete source and existing validated UI runtime artifact. No fresh dependency or Next build.',
          'base_local_image_id': BASE, 'target_tag': TAG, 'model_calls': 0,
          'application_services_started': 0, 'npm_pip_apt_next_build_commands': 0}
context = None
try:
    assert sha(FREEZE) == FREEZE_SHA, 'Source freeze record changed'
    freeze = json.loads(FREEZE.read_text())
    snapshot = CODE/freeze['source_snapshot']
    source_files = freeze['files']
    assert len(source_files) == freeze['file_count'] == 1170
    base = json.loads(run('sudo', '-n', 'docker', 'image', 'inspect', BASE).stdout)[0]
    assert base['Id'] == BASE
    base_env = dict(value.split('=', 1) for value in base['Config']['Env'])
    assert base_env.get('T1_WORKBENCH_MODEL_ENABLED') == 'false'
    assert base['Config']['User'] == '10001:10001'
    ui_report = json.loads((CODE/'docs/acceptance/resume-2026-11-11/ui/report.json').read_text())
    assert ui_report['passed'] is True
    for name, expected in ui_report['source_sha256'].items():
        assert source_files[name] == expected and sha(snapshot/name) == expected, name
    build = CODE/'apps/pi-web'/DIST
    assert (build/'BUILD_ID').read_text().strip() == BUILD_ID
    artifact_files = {}
    for path in sorted(build.rglob('*')):
        assert not path.is_symlink(), 'Unexpected symlink in prebuilt artifact'
        if path.is_file() and path.relative_to(build).parts[0] not in SKIP_ARTIFACT_ROOTS:
            artifact_files[str(path.relative_to(build))] = sha(path)
    assert hashlib.sha256(canonical(artifact_files)).hexdigest() == ARTIFACT_MANIFEST_SHA

    context = Path(tempfile.mkdtemp(prefix='final-stack-image-', dir=CODE/'runtime-data'))
    frozen = context/'frozen-source'
    for name, expected in source_files.items():
        parts = PurePosixPath(name).parts
        assert '..' not in parts and not name.startswith('/')
        assert not set(parts).intersection({'node_modules', '.next', 'runtime-data', '.venv', '.aws', '.git'})
        assert PurePosixPath(name).suffix.lower() not in {'.pdf', '.sqlite', '.db', '.pem'}
        assert not (PurePosixPath(name).name == '.env' or
                    PurePosixPath(name).name.startswith('.env.') and PurePosixPath(name).name != '.env.example')
        source = snapshot/name
        assert source.is_file() and not source.is_symlink() and sha(source) == expected, name
        target = frozen/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    artifact = context/'frontend-dist'
    for name, expected in artifact_files.items():
        target = artifact/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(build/name, target)
        assert sha(target) == expected

    # Inspection container is created and copied from, never started.
    inspection = run('sudo', '-n', 'docker', 'create', '--pull=never', '--network=none',
                     '--entrypoint=/bin/true', '--name=final-stack-locks-' + str(os.getpid()), BASE).stdout.strip()
    lock_results = {}
    try:
        for name in LOCKS:
            target = context/'dependency-check'/name
            target.parent.mkdir(parents=True, exist_ok=True)
            run('sudo', '-n', 'docker', 'cp', inspection + ':/app/' + name, str(target))
            actual = sha(target)
            assert actual == source_files[name], 'Cached dependency lock/config differs: ' + name
            lock_results[name] = {'sha256': actual, 'cached_base_equals_frozen_source': True}
    finally:
        run('sudo', '-n', 'docker', 'rm', '-v', inspection)

    dockerfile = f'''FROM {BASE}
USER root
COPY frozen-source/ /app/
COPY frontend-dist/ /app/apps/pi-web/{DIST}/
ENV T1_NEXT_DIST_DIR={DIST}
LABEL t1.source.freeze.sha256="{FREEZE_SHA}" t1.ui.build.id="{BUILD_ID}" t1.ui.manifest.sha256="{ARTIFACT_MANIFEST_SHA}" t1.parent.image.id="{BASE}"
USER 10001:10001
'''
    (context/'Dockerfile').write_text(dockerfile)
    (context/'.dockerignore').write_text('**\n!Dockerfile\n!frozen-source/**\n!frontend-dist/**\n')
    command = ['sudo', '-n', 'env', 'DOCKER_BUILDKIT=0', 'docker', 'build', '--pull=false',
               '--network=none', '-f', str(context/'Dockerfile'), '-t', TAG, str(context)]
    report.update({'source_freeze_record': str(FREEZE.relative_to(CODE)),
                   'source_freeze_record_sha256': FREEZE_SHA, 'frozen_at': freeze['frozen_at_utc'],
                   'source_snapshot': freeze['source_snapshot'], 'source_files_verified_and_overlaid': len(source_files),
                   'ui_source_pins': ui_report['source_sha256'],
                   'runtime_repair_pins': {name: source_files[name] for name in freeze['runtime_repair_files']},
                   'dependency_lock_config_checks': lock_results,
                   'base_repo_digests': base.get('RepoDigests', []),
                   'base_layers': len(base['RootFS']['Layers']),
                   'ui_build_id': BUILD_ID, 'ui_dist_dir': DIST,
                   'ui_artifact_manifest_canonicalization': 'UTF-8 JSON sorted keys with separators comma/colon',
                   'ui_artifact_manifest_sha256': ARTIFACT_MANIFEST_SHA,
                   'ui_artifact_files': artifact_files,
                   'ui_artifact_file_count': len(artifact_files),
                   'ui_artifact_bytes': sum((build/name).stat().st_size for name in artifact_files),
                   'ui_artifact_excluded_root_entries': sorted(SKIP_ARTIFACT_ROOTS),
                   'dockerfile': dockerfile,
                   'dockerfile_sha256': hashlib.sha256(dockerfile.encode()).hexdigest(),
                   'actual_build_command': command, 'build_context': str(context),
                   'build_context_contains_only': ['manifest-verified frozen-source/', 'manifest-verified frontend-dist/', 'generated Dockerfile/.dockerignore'],
                   'credentials_databases_input_pdfs_copied': False,
                   'no_dockerhub_syntax_frontend': True,
                   'inspection_container_started': False,
                   'construction_definition': str(Path(__file__).relative_to(CODE)),
                   'construction_definition_sha256': sha(Path(__file__))})
    with (EVIDENCE/'build.log').open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    image = json.loads(run('sudo', '-n', 'docker', 'image', 'inspect', TAG).stdout)[0]
    env = dict(value.split('=', 1) for value in image['Config']['Env'])
    assert env['T1_NEXT_DIST_DIR'] == DIST and env['T1_WORKBENCH_MODEL_ENABLED'] == 'false'
    assert image['Config']['User'] == '10001:10001'
    assert image['RootFS']['Layers'][:len(base['RootFS']['Layers'])] == base['RootFS']['Layers']
    report.update({'status': 'built-awaiting-backend-owner-preflight',
                   'local_image_id': image['Id'], 'repo_digests': image.get('RepoDigests', []),
                   'registry_push_performed': False,
                   'image_size_bytes': image['Size'], 'image_created_at': image['Created'],
                   'image_environment_verified': {name: env.get(name) for name in ['NODE_ENV', 'T1_NEXT_DIST_DIR', 'T1_WORKBENCH_MODEL_ENABLED', 'T1_IMPORT_RETAINED', 'HF_HUB_OFFLINE']},
                   'image_user': image['Config']['User'], 'image_cmd': image['Config']['Cmd'],
                   'parent_rootfs_layers_preserved': True,
                   'build_log_sha256': sha(EVIDENCE/'build.log'),
                   'cold_build_or_clean_dependency_install_claimed': False,
                   'ordinary_30141_or_shared_next_modified': False,
                   'next_owner': 'resume_s6_s7 performs first container source/UI pin verification and preflight; root alone dispatches model work.'})
except Exception as error:
    report.update({'status': 'failed', 'error': type(error).__name__ + ': ' + str(error)})
    raise
finally:
    if context is not None:
        shutil.rmtree(context)
    report['temporary_build_context_cleaned'] = context is None or not context.exists()
    report['finished_at'] = datetime.now(timezone.utc).isoformat()
    (EVIDENCE/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({name: report.get(name) for name in ['status', 'local_image_id', 'base_local_image_id', 'ui_build_id', 'temporary_build_context_cleaned']}, ensure_ascii=False))
