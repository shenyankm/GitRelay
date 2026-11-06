import json, os, queue, subprocess, tempfile, threading, time, urllib.request
from pathlib import Path

workspace = Path('/Users/sheny/Developer/code/GitRelay')
root = Path(tempfile.mkdtemp(prefix='gitrelay-mcp-usability-'))
main, sender, receiver = (root / name for name in ['main', 'sender', 'receiver'])
state, home = root / 'state', root / 'codex-home'
home.mkdir()
steps, calls, handles = [], [], []
started = time.monotonic()

def git(cwd, *args):
    return subprocess.check_output(['git', '-C', str(cwd), '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.test', '-c', 'commit.gpgsign=false', *args], stderr=subprocess.PIPE, text=True).strip()

git(root, 'init', '-b', 'main', str(main))
(main / 'shared.txt').write_text('baseline\n')
git(main, 'add', '.')
git(main, 'commit', '-m', 'baseline')
initial = git(main, 'rev-parse', 'HEAD')
for path in [sender, receiver]:
    git(main, 'worktree', 'add', '-b', path.name, str(path))
node = subprocess.check_output(['which', 'node'], text=True).strip()
(home / 'config.toml').write_text('[mcp_servers.git-relay]\ncommand = ' + json.dumps(node) + '\nargs = ' + json.dumps([str(workspace / 'dist/mcp/main.js'), '--cwd', str(main)]) + '\nenv = { WORKTREE_SYNC_STATE_DIR = ' + json.dumps(str(state)) + ' }\n')

class Host:
    def __init__(self):
        self.child = subprocess.Popen(['codex', '--no-daemon', 'app-server', '--listen', 'stdio://'], cwd=main, env={**os.environ, 'CODEX_HOME': str(home), 'WORKTREE_SYNC_STATE_DIR': str(state)}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.messages, self.errors, self.seq = queue.Queue(), [], 0
        def read():
            for line in self.child.stdout:
                try: self.messages.put(json.loads(line))
                except ValueError: pass
            self.messages.put({'closed': True})
        def diagnostics():
            for line in self.child.stderr: self.errors.append(line)
        threading.Thread(target=read, daemon=True).start()
        threading.Thread(target=diagnostics, daemon=True).start()
        self.rpc('initialize', {'clientInfo': {'name': 'gitrelay-usability', 'version': '0.2.0'}, 'capabilities': {'experimentalApi': True}})
        self.child.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'initialized'}) + '\n')
        self.child.stdin.flush()

    def rpc(self, method, params):
        self.seq += 1
        ident = self.seq
        self.child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params}) + '\n')
        self.child.stdin.flush()
        deadline = time.monotonic() + 25
        while True:
            message = self.messages.get(timeout=max(.01, deadline - time.monotonic()))
            if message.get('closed'): raise RuntimeError('Codex host disconnected')
            if message.get('id') == ident:
                assert 'error' not in message, message.get('error')
                return message['result']

    def thread(self, cwd):
        return self.rpc('thread/start', {'cwd': str(cwd), 'ephemeral': True, 'approvalPolicy': 'never', 'sandbox': 'danger-full-access'})['thread']['id']

    def tool(self, thread, name, args=None):
        began = time.monotonic()
        result = self.rpc('mcpServer/tool/call', {'threadId': thread, 'server': 'git-relay', 'tool': name, 'arguments': args or {}})
        assert not result.get('isError'), result.get('content')
        calls.append({'name': name, 'elapsedMs': round((time.monotonic() - began) * 1000, 2), 'passed': True})
        return result['structuredContent']

    def close(self):
        self.child.stdin.close()
        try: self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            self.child.wait(timeout=5)

host = None
try:
    host = Host()
    a, b = host.thread(sender), host.thread(receiver)
    inventory = host.rpc('mcpServerStatus/list', {'threadId': a, 'serverName': 'git-relay'})['data'][0]
    assert inventory['runtimeStatus'] == 'connected' and not inventory.get('toolsError')
    assert len(inventory['tools']) == 19
    assert host.tool(b, 'branch_status', {'cwd': str(receiver)})['worktree']['branch'] == 'receiver'
    assert host.tool(b, 'list_sessions', {'cwd': str(receiver)})['sessions'] == []
    assert not state.exists() and not (main / '.git' / '.git-relay-id').exists()
    steps.append('native discovery of 19 tools and read-only calls without relay initialization')
    writer = host.tool(a, 'join_session', {'cwd': str(sender)})
    reader = host.tool(b, 'join_session', {'cwd': str(receiver)})
    handles.extend([writer['sessionToken'], reader['sessionToken']])
    assert handles[0] != handles[1] and reader['sessionToken'] != reader['session']['session']
    writer_args = {'cwd': str(sender), 'sessionToken': handles[0]}
    reader_args = {'cwd': str(receiver), 'sessionToken': handles[1]}
    event = host.tool(a, 'send_message', {**writer_args, 'text': '可用性验收：跨工作树消息'})
    batch = host.tool(b, 'receive_messages', reader_args)
    assert len(batch['notifications']) == 1 and batch['notifications'][0]['event']['id'] == event['eventId']
    repo_dir = state / 'repos' / next((state / 'repos').iterdir()).name
    receipt = repo_dir / 'receipts' / reader['session']['key'] / (event['eventId'] + '.json')
    assert not receipt.exists()
    steps.append('two native Codex threads join and exchange a message without implicit acknowledgement')
    host.close()
    host = Host()
    a, b = host.thread(sender), host.thread(receiver)
    repeated = host.tool(b, 'receive_messages', reader_args)
    assert repeated['deliveryId'] == batch['deliveryId'] and repeated['notifications'][0]['event']['id'] == event['eventId']
    ack_args = {**reader_args, 'deliveryId': repeated['deliveryId']}
    accepted = host.tool(b, 'acknowledge_messages', ack_args)
    assert accepted['acknowledged'] == [event['eventId']]
    assert host.tool(b, 'acknowledge_messages', ack_args)['alreadyAcknowledged'] is True
    assert json.loads(receipt.read_text())['status'] == 'delivered'
    assert host.tool(b, 'receive_messages', reader_args)['notifications'] == []
    steps.append('host restart preserves unread delivery; explicit acknowledgement is durable and idempotent')
    (receiver / 'shared.txt').write_text('my unfinished work\n')
    (main / 'shared.txt').write_text('upstream change\n')
    git(main, 'add', 'shared.txt')
    git(main, 'commit', '-m', 'upstream change')
    upstream_commit = git(main, 'rev-parse', 'HEAD')
    upstream = host.tool(b, 'receive_messages', reader_args)
    assert len(upstream['notifications']) == 1
    assert upstream['notifications'][0]['event']['kind'] == 'upstream' and upstream['notifications'][0]['event']['commit'] == upstream_commit
    host.tool(b, 'acknowledge_messages', {**reader_args, 'deliveryId': upstream['deliveryId']})
    sync = host.tool(b, 'sync_branch', {'cwd': str(receiver), 'branch': 'receiver'})
    assert sync['state'] == 'blocked'
    assert (receiver / 'shared.txt').read_text() == 'my unfinished work\n' and git(receiver, 'rev-parse', 'HEAD') == initial
    steps.append('upstream notification and blocked synchronization preserve dirty bytes and HEAD')
    pending = host.tool(a, 'send_message', {**writer_args, 'text': '浏览器验收：中文消息与 <b>纯文本</b>'})
    pending_receipt = repo_dir / 'receipts' / reader['session']['key'] / (pending['eventId'] + '.json')
    console = host.tool(b, 'open_console', {'cwd': str(receiver), 'port': 0})
    url = console['url']
    with urllib.request.urlopen(url + '/api/snapshot') as response:
        snapshot = json.load(response)
    assert len(snapshot['worktrees']) == 3 and len(snapshot['sessions']) == 2
    assert next(item for item in snapshot['events'] if item['id'] == pending['eventId'])['delivery'][0]['status'] == 'pending'
    assert not pending_receipt.exists()
    (root / 'ready.json').write_text(json.dumps({'url': url, 'root': str(root), 'stepsPassed': steps, 'pendingEventId': pending['eventId']}))
    print(json.dumps({'phase': 'browser-ready', 'url': url, 'root': str(root)}, ensure_ascii=False), flush=True)
    deadline = time.monotonic() + 240
    while not (root / 'continue').exists():
        assert time.monotonic() < deadline, 'Browser acceptance did not finish in 240 seconds'
        time.sleep(.2)
    assert not pending_receipt.exists()
    steps.append('Web console and browser observation preserve unread state')
    final_batch = host.tool(b, 'receive_messages', reader_args)
    assert any(item['event']['id'] == pending['eventId'] for item in final_batch['notifications'])
    host.tool(b, 'acknowledge_messages', {**reader_args, 'deliveryId': final_batch['deliveryId']})
    assert json.loads(pending_receipt.read_text())['status'] == 'delivered'
    for thread, args in [(a, writer_args), (b, reader_args)]: assert host.tool(thread, 'leave_session', args)['left']
    assert all(item.get('closedAt') for item in host.tool(b, 'list_sessions', {'cwd': str(receiver)})['sessions'])
    host.close()
    host = None
    try:
        urllib.request.urlopen(url, timeout=2)
        raise AssertionError('Web console listener survived host shutdown')
    except OSError: pass
    host = Host()
    observer = host.thread(main)
    assert host.tool(observer, 'monitor_status')['running'] is False
    steps.append('explicit leave retains session records; final disconnect closes Web listener and monitor')
    result = {'status': 'passed', 'codexVersion': subprocess.check_output(['codex', '--version'], text=True).strip(), 'serverVersion': inventory['serverInfo']['version'], 'toolCount': len(inventory['tools']), 'steps': steps, 'calls': calls, 'modelTurns': 0, 'normalConfigModified': False, 'elapsedSeconds': round(time.monotonic() - started, 2), 'fixtureRoot': str(root), 'consoleUrl': url}
    (root / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'phase': 'complete', 'status': 'passed', 'result': str(root / 'result.json'), 'nativeToolCalls': len(calls)}, ensure_ascii=False), flush=True)
finally:
    if host is not None: host.close()
