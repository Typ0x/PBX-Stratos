import json
import subprocess
import sys
from pathlib import Path

SCRUB = str(Path(__file__).parent / 'scrub.py')
KEYPAIR = '[' + ','.join(['123'] * 64) + ']'


def _git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args],
                          capture_output=True, text=True)


def _new_repo(tmp_path):
    repo = tmp_path / 'r'
    repo.mkdir()
    _git(repo, 'init', '-q')
    _git(repo, 'config', 'user.email', 't@t')
    _git(repo, 'config', 'user.name', 't')
    return repo


def _run_staged(repo):
    return subprocess.run([sys.executable, SCRUB, '--staged'],
                          cwd=str(repo), capture_output=True, text=True)


def test_whole_file_secret_is_unstaged_and_gitignored(tmp_path):
    repo = _new_repo(tmp_path)
    (repo / 'bot.keypair.json').write_text(KEYPAIR)
    _git(repo, 'add', 'bot.keypair.json')
    r = _run_staged(repo)
    assert r.returncode == 0
    staged = _git(repo, 'diff', '--cached', '--name-only').stdout
    assert 'bot.keypair.json' not in staged
    assert 'bot.keypair.json' in (repo / '.gitignore').read_text()


def test_inline_secret_is_redacted(tmp_path):
    repo = _new_repo(tmp_path)
    (repo / 'config.py').write_text('OPENAI = "sk-' + 'A' * 32 + '"\n')
    _git(repo, 'add', 'config.py')
    r = _run_staged(repo)
    assert r.returncode == 0
    body = (repo / 'config.py').read_text()
    assert '[REDACTED]' in body and 'sk-AAAA' not in body
    assert 'config.py' in _git(repo, 'diff', '--cached', '--name-only').stdout


def test_clean_commit_is_untouched(tmp_path):
    repo = _new_repo(tmp_path)
    (repo / 'app.py').write_text('print("hello")\n')
    _git(repo, 'add', 'app.py')
    r = _run_staged(repo)
    assert r.returncode == 0
    assert (repo / 'app.py').read_text() == 'print("hello")\n'


def test_private_key_emits_rotate_warning(tmp_path):
    repo = _new_repo(tmp_path)
    (repo / 'w.json').write_text(KEYPAIR)
    _git(repo, 'add', 'w.json')
    r = _run_staged(repo)
    assert 'compromised' in r.stderr.lower() and 'rotate' in r.stderr.lower()


def test_sessions_redacts_secret_in_transcript(tmp_path, monkeypatch):
    sessions = tmp_path / 'projects' / 'p'
    sessions.mkdir(parents=True)
    f = sessions / 'chat.jsonl'
    f.write_text('{"text": "my key is sk-' + 'B' * 32 + ' ok"}\n')
    monkeypatch.setenv('PBX_SESSIONS_DIR', str(tmp_path / 'projects'))
    r = subprocess.run([sys.executable, SCRUB, '--sessions'],
                       capture_output=True, text=True)
    assert r.returncode == 0
    assert '[REDACTED]' in f.read_text() and 'sk-BBBB' not in f.read_text()
