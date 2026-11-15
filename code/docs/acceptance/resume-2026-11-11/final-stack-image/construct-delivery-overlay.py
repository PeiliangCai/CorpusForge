"""Final bounded high-load reliability overlay; all tested reports remain immutable."""
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import hashlib, json, shutil, subprocess, tarfile, tempfile

CODE = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent
FREEZE = CODE/'docs/acceptance/resume-2026-11-11/delivery-source-freeze.json'
FREEZE_SHA = '34469b992a0ec8647fa4f59dbc1d7f6c870dbeb2536bf7c46bbdb5f06c663bb9'
PARENT = 'sha256:32a0e53ab6be8bed82c579b8be589cbb25787f076d5133f74163999724d76977'
TAG = 't1-workbench:delivery-20261111'
DIST = 'build/ui-next-20261111'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
digest = lambda value: hashlib.sha256(canonical(value)).hexdigest()
run = lambda *args: subprocess.run(args, check=True, capture_output=True, text=True)

PARENT_REPORT = EVIDENCE/'diagnostic-layer-report.json'
PARENT_REPORT_SHA = sha(PARENT_REPORT)
assert PARENT_REPORT_SHA == '4745cc0ba854fce85024afe561379c422e4e897782679614cb76963004bf67fd'
STACK_REPORT = EVIDENCE/'report.json'
STACK_REPORT_SHA = sha(STACK_REPORT)
assert STACK_REPORT_SHA == 'd63012c46e22e07481b17d96f96614a26d7a49b5af47187b54c62595fea7038c'
prior_stack = json.loads(PARENT_REPORT.read_text())
initial = json.loads(STACK_REPORT.read_text())['initial_unified_build']
assert prior_stack['final_local_image_id'] == PARENT
report = {'schema_version': 't1-final-delivery-image-lineage-1', 'cold_build': False,
          'started_at': datetime.now(timezone.utc).isoformat(),
          'prior_tested_diagnostic_report': {'path': str(PARENT_REPORT.relative_to(CODE)),
              'sha256': PARENT_REPORT_SHA, 'local_image_id': PARENT,
              'executed_IN07_plan_binding_preserved': True},
          'prior_tested_stack_report': {'path': str(STACK_REPORT.relative_to(CODE)),
              'sha256': STACK_REPORT_SHA, 'executed_IN06_plan_binding_preserved': True},
          'delivery_reliability_only': True,
          'provider_capacity_or_prior_error_repair_claimed': False,
          'live_provider_recovery_after_patch_verified': False,
          'prior_failed_records_or_experimental_allowances_modified': False,
          'all_experimental_allowances_closed': True,
          'ordinary_readonly_browser_evidence': 'ui/delivery-readonly-report.json',
          'model_calls_for_image_construction': 0, 'application_services_started_for_construction': 0}
context, inspection = None, None
try:
    assert sha(FREEZE) == FREEZE_SHA, 'Final execution freeze changed'
    freeze = json.loads(FREEZE.read_text())
    files, overlay = freeze['files'], freeze['overlay_files']
    assert len(files) == freeze['file_count'] == 1176 and len(overlay) == 4
    snapshot = CODE/freeze['source_snapshot']
    prior = json.loads((CODE/prior_stack['diagnostic_overlay']['source_freeze_record']).read_text())
    delta = {name: value for name, value in files.items() if prior['files'].get(name) != value}
    assert delta == overlay and not set(prior['files']).difference(files), 'Unexpected change outside final overlay'
    for name, expected in files.items():
        source = snapshot/name
        assert source.is_file() and not source.is_symlink() and sha(source) == expected, name
    for name, check in initial['dependency_lock_config_checks'].items():
        assert files[name] == check['sha256'], 'Dependency lock/config changed'
    for name, expected in initial['ui_source_pins'].items():
        assert files[name] == expected, 'UI source changed after accepted build'
    assert not any(name.startswith('apps/pi-web/') for name in overlay), 'Final overlay must not modify UI'
    parent = json.loads(run('sudo', '-n', 'docker', 'image', 'inspect', PARENT).stdout)[0]
    assert parent['Id'] == PARENT

    context = Path(tempfile.mkdtemp(prefix='final-delivery-overlay-', dir=CODE/'runtime-data'))
    for name, expected in overlay.items():
        parts = PurePosixPath(name).parts
        assert '..' not in parts and not name.startswith('/')
        assert not set(parts).intersection({'node_modules', '.next', 'runtime-data', '.venv', '.aws', '.git'})
        assert PurePosixPath(name).name != '.env' and not PurePosixPath(name).name.startswith('.env.')
        assert PurePosixPath(name).suffix.lower() not in {'.pdf', '.sqlite', '.db', '.pem'}
        target = context/'overlay'/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(snapshot/name, target)
        assert sha(target) == expected
    dockerfile = f'''FROM {PARENT}
USER root
COPY overlay/ /app/
LABEL t1.source.freeze.sha256="{FREEZE_SHA}" t1.delivery.overlay.parent="{PARENT}"
USER 10001:10001
'''
    (context/'Dockerfile').write_text(dockerfile)
    (context/'.dockerignore').write_text('**\n!Dockerfile\n!overlay/**\n')
    command = ['sudo', '-n', 'env', 'DOCKER_BUILDKIT=0', 'docker', 'build', '--pull=false',
               '--network=none', '-f', str(context/'Dockerfile'), '-t', TAG, str(context)]
    with (EVIDENCE/'build-delivery-overlay.log').open('w') as log:
        subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
    image = json.loads(run('sudo', '-n', 'docker', 'image', 'inspect', TAG).stdout)[0]
    env = dict(value.split('=', 1) for value in image['Config']['Env'])
    assert env['T1_NEXT_DIST_DIR'] == DIST and env['T1_WORKBENCH_MODEL_ENABLED'] == 'false'
    assert image['Config']['User'] == '10001:10001'
    assert image['RootFS']['Layers'][:len(parent['RootFS']['Layers'])] == parent['RootFS']['Layers']

    # Copy only whitelisted expected files from tar streams. This avoids a huge
    # argv, root-owned extraction trees, dependencies and any runtime database.
    wanted = dict(files)
    ui_prefix = 'apps/pi-web/' + DIST
    for name, expected in initial['ui_artifact_files'].items():
        wanted[ui_prefix + '/' + name] = expected
    roots = set()
    for name in files:
        parts = PurePosixPath(name).parts
        if parts[0] in {'packages', 'services'}:
            roots.add('/'.join(parts[:2]))
        elif parts[:2] in {('apps', 'pi-web'), ('apps', 'server')} and len(parts) > 3:
            roots.add('/'.join(parts[:3]))
        elif parts[0] in {'deploy', 'config', 'scripts'}:
            roots.add(parts[0])
        else:
            roots.add(name)
    roots.add(ui_prefix)
    inspection = run('sudo', '-n', 'docker', 'create', '--pull=never', '--network=none',
                     '--entrypoint=/bin/true', image['Id']).stdout.strip()
    checked = context/'checked-image-files'
    seen = set()
    for job in sorted(roots):
        prefix = PurePosixPath(job).parent
        process = subprocess.Popen(['sudo', '-n', 'docker', 'cp', inspection + ':/app/' + job, '-'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
                for member in archive:
                    name = PurePosixPath(member.name)
                    assert not name.is_absolute() and '..' not in name.parts
                    relative = str(prefix/name)
                    if not member.isfile() or relative not in wanted:
                        continue
                    target = checked/relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    stream = archive.extractfile(member)
                    assert stream is not None
                    with target.open('wb') as output:
                        shutil.copyfileobj(stream, output)
                    seen.add(relative)
        finally:
            process.stdout.close()
            error = process.stderr.read().decode()
            code = process.wait()
            assert code == 0, error
    actual = {name: sha(checked/name) for name in files if name in seen}
    missing = sorted(set(files).difference(actual))
    mismatches = [name for name in actual if actual[name] != files[name]]
    assert not missing and not mismatches and len(actual) == 1176, (missing, mismatches)
    artifact_actual = {name: sha(checked/ui_prefix/name) for name in initial['ui_artifact_files']}
    assert artifact_actual == initial['ui_artifact_files']
    assert digest(artifact_actual) == initial['ui_artifact_manifest_sha256']
    assert (checked/ui_prefix/'BUILD_ID').read_text().strip() == initial['ui_build_id']
    run('sudo', '-n', 'docker', 'rm', '-v', inspection)
    inspection = None
    report.update({'status': 'delivery-image-built-offline-pins-verified',
                   'final_local_image_id': image['Id'], 'final_image_tag': TAG,
                   'image_lineage': prior_stack['image_lineage'] + [image['Id']],
                   'delivery_overlay': {'parent_local_image_id': PARENT, 'local_image_id': image['Id'],
                       'repo_digests': image.get('RepoDigests', []), 'registry_push_performed': False,
                       'source_freeze_record': str(FREEZE.relative_to(CODE)), 'source_freeze_sha256': FREEZE_SHA,
                       'source_snapshot': freeze['source_snapshot'], 'source_frozen_at': freeze['frozen_at_utc'],
                       'overlay_files': overlay, 'dockerfile': dockerfile,
                       'dockerfile_sha256': hashlib.sha256(dockerfile.encode()).hexdigest(),
                       'actual_build_command': command, 'image_size_bytes': image['Size'],
                       'build_log_sha256': sha(EVIDENCE/'build-delivery-overlay.log'),
                       'construction_definition': str(Path(__file__).relative_to(CODE)),
                       'construction_definition_sha256': sha(Path(__file__)),
                       'no_dependency_or_UI_build': True, 'no_syntax_frontend_or_registry_pull': True,
                       'credentials_databases_input_pdfs_copied': False,
                       'parent_rootfs_layers_preserved': True,
                       'image_environment_verified': {name: env.get(name) for name in ['NODE_ENV', 'T1_NEXT_DIST_DIR', 'T1_WORKBENCH_MODEL_ENABLED', 'T1_IMPORT_RETAINED']},
                       'image_user': image['Config']['User'], 'image_cmd': image['Config']['Cmd']},
                   'all_frozen_source_pins': {'expected': 1176, 'matched': len(actual), 'missing': missing,
                       'mismatches': mismatches, 'expected_manifest_sha256': digest(files),
                       'actual_image_manifest_sha256': digest(actual),
                       'method': 'Grouped docker cp tar streams from an unstarted final-image container; files whitelisted and hashed by Python against freeze JSON, never a large argv.'},
                   'final_UI_artifact_verification': {'source_pins': initial['ui_source_pins'],
                       'build_id': initial['ui_build_id'], 'dist_dir': DIST,
                       'expected_files': 161, 'matched_files': len(artifact_actual),
                       'manifest_sha256': digest(artifact_actual), 'byte_for_byte_identical_to_accepted_UI': True},
                   'source_roles': freeze.get('source_roles', 'See final execution freeze and its predecessor'),
                   'S6_complete_acceptance_claimed': False, 'medical_quality_approved': False,
                   'ordinary_30141_or_shared_next_modified': False,
                   'next_owner': 'resume_s6_s7 alone starts first final-container preflight; root alone dispatches paid model work.'})
except Exception as error:
    report.update({'status': 'final-overlay-failed', 'error': type(error).__name__ + ': ' + str(error)})
    raise
finally:
    if inspection is not None:
        run('sudo', '-n', 'docker', 'rm', '-v', inspection)
    if context is not None:
        shutil.rmtree(context)
    report['temporary_final_context_cleaned'] = context is None or not context.exists()
    report['finished_at'] = datetime.now(timezone.utc).isoformat()
    report['parent_tested_report_bytes_unchanged'] = sha(PARENT_REPORT) == PARENT_REPORT_SHA
    report['prior_stack_report_bytes_unchanged'] = sha(STACK_REPORT) == STACK_REPORT_SHA
    assert report['parent_tested_report_bytes_unchanged'] and report['prior_stack_report_bytes_unchanged'], 'Bound historical report changed'
    (EVIDENCE/'delivery-image-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({name: report.get(name) for name in ['status', 'final_local_image_id', 'final_image_tag', 'temporary_final_context_cleaned']}, ensure_ascii=False))
