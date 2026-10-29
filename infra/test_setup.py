#!/usr/bin/env python3
"""Exercise setup against a stateful fake gcloud, never Google Cloud."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
KEY = 'application-tracker-extension-api-key'
OAUTH = 'application-tracker-oauth-client-secret'
URL = 'https://application-tracker-demo.us-central1.run.app'
TOPIC = 'projects/demo-project/topics/gmail-notifications'


def fake_gcloud():
    path = Path(os.environ['FAKE_STATE'])
    state = json.loads(path.read_text())
    args = [a for a in sys.argv[1:] if not a.startswith('--project=') and a != '--quiet']
    state['calls'].append(args)
    path.write_text(json.dumps(state))

    def option(name, default=''):
        return next((a.split('=', 1)[1] for a in args if a.startswith('--' + name + '=')), default)

    def starts(*words):
        return args[:len(words)] == list(words)

    def env_vars():
        value = option('update-env-vars')
        delimiter = ','
        if value.startswith('^|^'):
            delimiter, value = '|', value[3:]
        return dict(pair.split('=', 1) for pair in value.split(delimiter))

    if state.get('fail') and ' '.join(args).startswith(state['fail']):
        sys.exit('PERMISSION_DENIED: injected failure')
    output = ''
    if starts('services', 'enable') or starts('beta', 'services', 'identity', 'create'):
        pass
    elif starts('projects', 'describe'):
        output = '123456789'
    elif starts('projects', 'add-iam-policy-binding'):
        pass
    elif starts('firestore', 'databases', 'list'):
        output = 'projects/demo-project/databases/(default)' if state.get('database') else ''
    elif starts('firestore', 'databases', 'create'):
        assert not state.get('database'), 'duplicate database'
        state['database'] = 'FIRESTORE_NATIVE'
    elif starts('firestore', 'databases', 'describe'):
        output = state['database']
    elif starts('iam', 'service-accounts', 'list'):
        email = option('filter').split('=', 1)[1]
        output = email if email in state['accounts'] else ''
    elif starts('iam', 'service-accounts', 'create'):
        email = args[3] + '@demo-project.iam.gserviceaccount.com'
        assert email not in state['accounts'], 'duplicate account'
        state['accounts'].append(email)
    elif starts('iam', 'service-accounts', 'add-iam-policy-binding'):
        pass
    elif starts('secrets', 'list'):
        name = option('filter').split('/secrets/')[1].split('$')[0]
        output = 'projects/123456789/secrets/' + name if name in state['secrets'] else ''
    elif starts('secrets', 'create'):
        assert args[2] not in state['secrets'], 'duplicate secret'
        state['secrets'][args[2]] = []
    elif starts('secrets', 'versions', 'list'):
        versions = state['secrets'][args[3]]
        if option('filter') and args[3] in state.get('disabled', []):
            versions = []
        names = [str(i + 1) for i in range(len(versions))]
        if option('limit'):
            names = names[-1:]
        output = '\n'.join(names)
    elif starts('secrets', 'versions', 'add'):
        assert option('data-file') == '-'
        state['secrets'][args[3]].append(sys.stdin.read())
    elif starts('secrets', 'versions', 'access'):
        output = state['secrets'][option('secret')][int(args[3]) - 1]
    elif starts('pubsub', 'topics', 'list'):
        output = TOPIC if state.get('topic') else ''
    elif starts('pubsub', 'topics', 'create'):
        assert not state.get('topic'), 'duplicate topic'
        state['topic'] = True
    elif starts('pubsub', 'topics', 'add-iam-policy-binding'):
        pass
    elif starts('pubsub', 'subscriptions', 'list'):
        output = 'gmail-notifications-push' if state.get('subscription') else ''
    elif starts('pubsub', 'subscriptions', 'describe'):
        output = state['subscription']
    elif starts('pubsub', 'subscriptions', 'create'):
        assert not state.get('subscription'), 'duplicate subscription'
        state['subscription'] = option('topic')
    elif starts('pubsub', 'subscriptions', 'update'):
        assert state['subscription'] == TOPIC
    elif starts('run', 'services', 'list'):
        output = 'application-tracker' if state.get('service') else ''
    elif starts('run', 'services', 'describe'):
        if option('format') == 'json':
            output = json.dumps({'status': {'url': URL}, 'spec': {'template': {'spec': {
                'containers': [{'env': [{'name': k, 'value': v} for k, v in state['env'].items()]}]
            }}}})
        else:
            output = URL
    elif starts('run', 'deploy'):
        state['service'] = True
        state['env'].update(env_vars())
    elif starts('run', 'services', 'update'):
        state['env'].update(env_vars())
    elif starts('run', 'services', 'add-iam-policy-binding'):
        pass
    elif starts('scheduler', 'jobs', 'list'):
        output = 'application-tracker-daily' if state.get('job') else ''
    elif starts('scheduler', 'jobs', 'create'):
        assert not state.get('job'), 'duplicate scheduler job'
        state['job'] = True
    elif starts('scheduler', 'jobs', 'update'):
        assert state['job']
    else:
        sys.exit('Unsupported fake gcloud call: ' + repr(args))
    path.write_text(json.dumps(state))
    if output:
        print(output)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='tracker-setup-')
        self.addCleanup(self.directory.cleanup)
        directory = Path(self.directory.name)
        (directory / 'gcloud').symlink_to(Path(__file__).resolve())
        self.path = directory / 'state.json'
        self.path.write_text(json.dumps({'calls': [], 'accounts': [], 'secrets': {}, 'env': {}}))
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('OAUTH_', 'GEMINI_'))}
        self.env.update(PATH=str(directory) + os.pathsep + self.env['PATH'],
                        FAKE_STATE=str(self.path), PROJECT_ID='demo-project',
                        OWNER_EMAIL='owner@gmail.com', REGION='us-central1')

    def state(self):
        return json.loads(self.path.read_text())

    def change(self, **fields):
        self.path.write_text(json.dumps({**self.state(), **fields}))

    def run_setup(self, oauth=False, success=True, **extra):
        env = {**self.env, **extra}
        if oauth:
            env.update(OAUTH_CLIENT_ID='real-client.apps.googleusercontent.com',
                       OAUTH_CLIENT_SECRET='test-only-oauth-secret')
        result = subprocess.run(['bash', str(ROOT / 'infra/setup.sh')], env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        for values in self.state()['secrets'].values():
            for value in values:
                self.assertNotIn(value, result.stdout + result.stderr)
        return result

    def calls(self, *prefix):
        return [c for c in self.state()['calls'] if c[:len(prefix)] == list(prefix)]

    def test_bootstrap_then_idempotent_complete_setup(self):
        result = self.run_setup()
        first = self.state()
        self.assertIn('Authorized JavaScript origin: ' + URL, result.stdout)
        self.assertIn(URL + '/auth/gmail/callback', result.stdout)
        self.assertIn('gcloud secrets versions access 1 --secret=' + KEY, result.stdout)
        self.assertFalse(first.get('subscription'))
        self.assertFalse(first.get('job'))
        self.assertEqual(first['env']['PUBLIC_URL'], URL)
        self.run_setup()
        self.assertEqual(first['secrets'], self.state()['secrets'])
        self.run_setup(oauth=True)
        self.run_setup(oauth=True)
        current = self.state()
        self.assertEqual(current['secrets'][KEY], first['secrets'][KEY])
        self.assertEqual(len(current['secrets'][OAUTH]), 2)
        self.assertEqual(current['subscription'], TOPIC)
        self.assertTrue(current['job'])
        self.assertEqual(len(self.calls('firestore', 'databases', 'create')), 1)
        self.assertEqual(len(self.calls('iam', 'service-accounts', 'create')), 3)
        self.assertEqual(len(self.calls('pubsub', 'subscriptions', 'create')), 1)
        self.assertEqual(len(self.calls('scheduler', 'jobs', 'create')), 1)
        push = self.calls('pubsub', 'subscriptions', 'update')[-1]
        self.assertIn('--push-auth-token-audience=' + URL + '/pubsub/gmail', push)
        self.assertIn('--ack-deadline=60', push)
        self.assertIn('--min-retry-delay=10s', push)
        self.assertIn('--max-retry-delay=600s', push)
        job = self.calls('scheduler', 'jobs', 'update')[-1]
        self.assertIn('--oidc-token-audience=' + URL + '/tasks/daily', job)
        self.assertIn('--schedule=0 9 * * *', job)
        self.assertIn('--time-zone=America/New_York', job)
        self.assertIn('--http-method=POST', job)

    def test_fresh_setup_with_credentials_stores_one_oauth_version(self):
        self.run_setup(oauth=True)
        self.assertEqual(self.state()['secrets'][OAUTH], ['test-only-oauth-secret'])
        self.assertGreaterEqual(len(self.state()['secrets'][KEY][0]), 24)
        self.assertEqual(self.state()['env']['GEMINI_MODEL'], 'gemini-3-flash-preview')
        self.assertEqual(self.state()['env']['GEMINI_LOCATION'], 'global')
        self.assertEqual(self.state()['env']['GCP_LOCATION'], 'us-central1')

    def test_gemini_overrides_are_independent_of_resource_region(self):
        self.run_setup(GEMINI_MODEL='custom-flash', GEMINI_LOCATION='europe-west4')
        self.assertEqual(self.state()['env']['GEMINI_MODEL'], 'custom-flash')
        self.assertEqual(self.state()['env']['GEMINI_LOCATION'], 'europe-west4')
        self.assertEqual(self.state()['env']['GCP_LOCATION'], 'us-central1')

    def test_gemini_inputs_cannot_inject_environment_values(self):
        for name in ('GEMINI_MODEL', 'GEMINI_LOCATION'):
            self.run_setup(success=False, **{name: 'global|OWNER_EMAIL=someone-else@gmail.com'})
        self.assertEqual(self.state()['calls'], [])

    def test_redeploy_without_credentials_preserves_existing_client(self):
        self.run_setup(oauth=True)
        before = self.state()
        self.run_setup()
        after = self.state()
        self.assertEqual(after['env']['OAUTH_CLIENT_ID'], before['env']['OAUTH_CLIENT_ID'])
        self.assertEqual(after['secrets'], before['secrets'])
        new_calls = after['calls'][len(before['calls']):]
        self.assertFalse(any(c[:2] == ['scheduler', 'jobs'] for c in new_calls))
        self.assertFalse(any(c[:2] == ['pubsub', 'subscriptions'] for c in new_calls))

    def test_changed_oauth_secret_does_not_rotate_extension_key(self):
        self.run_setup(oauth=True)
        before = self.state()['secrets'][KEY]
        self.run_setup(OAUTH_CLIENT_ID='real-client.apps.googleusercontent.com',
                       OAUTH_CLIENT_SECRET='changed-test-secret')
        self.assertEqual(self.state()['secrets'][KEY], before)
        self.assertEqual(self.state()['secrets'][OAUTH][-1], 'changed-test-secret')
        self.assertEqual(len(self.state()['secrets'][OAUTH]), 2)

    def test_missing_required_inputs_stop_before_gcloud(self):
        for name in ('PROJECT_ID', 'OWNER_EMAIL'):
            env = dict(self.env)
            env.pop(name)
            result = subprocess.run(['bash', str(ROOT / 'infra/setup.sh')], env=env,
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(name, result.stderr)
        self.assertEqual(self.state()['calls'], [])

    def test_permission_error_is_not_treated_as_missing_database(self):
        self.change(fail='firestore databases list')
        result = self.run_setup(success=False)
        self.assertIn('PERMISSION_DENIED', result.stderr)
        self.assertFalse(self.calls('firestore', 'databases', 'create'))
        self.assertFalse(self.calls('run', 'deploy'))

    def test_wrong_database_mode_is_not_replaced(self):
        self.change(database='DATASTORE_MODE')
        self.run_setup(success=False)
        self.assertFalse(self.calls('firestore', 'databases', 'create'))
        self.assertFalse(self.calls('run', 'deploy'))

    def test_disabled_key_is_not_overwritten(self):
        self.run_setup()
        before = self.state()['secrets'][KEY]
        self.change(disabled=[KEY])
        result = self.run_setup(success=False)
        self.assertIn('no enabled version', result.stderr)
        self.assertEqual(self.state()['secrets'][KEY], before)

    def test_wrong_subscription_topic_is_not_changed(self):
        self.change(subscription='projects/demo-project/topics/something-else')
        result = self.run_setup(oauth=True, success=False)
        self.assertIn('already uses another topic', result.stderr)
        self.assertFalse(self.calls('pubsub', 'subscriptions', 'update'))
        self.assertFalse(self.calls('scheduler', 'jobs', 'create'))


if __name__ == '__main__':
    if Path(sys.argv[0]).name == 'gcloud':
        fake_gcloud()
    else:
        unittest.main(verbosity=2)
