from detect import find_secrets, is_whole_file_secret

SOLANA_KEYPAIR = '[' + ','.join(['123'] * 64) + ']'
MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

def test_detects_solana_keypair():
    f = find_secrets(SOLANA_KEYPAIR)
    assert len(f) == 1 and f[0].kind == 'solana_keypair' and f[0].is_private_key

def test_array_of_non_bytes_is_not_a_keypair():
    not_key = '[' + ','.join(['999'] * 64) + ']'
    assert find_secrets(not_key) == []

def test_detects_mnemonic():
    f = find_secrets(MNEMONIC)
    assert len(f) == 1 and f[0].kind == 'mnemonic' and f[0].is_private_key

def test_ordinary_prose_is_not_a_mnemonic():
    assert find_secrets('the cat sat on the mat and then it ran away fast today') == []

def test_detects_github_token():
    f = find_secrets('token=ghp_' + 'a' * 36)
    assert len(f) == 1 and f[0].kind == 'github_token' and not f[0].is_private_key

def test_detects_openai_key():
    f = find_secrets('OPENAI=sk-' + 'A' * 32)
    assert len(f) == 1 and f[0].kind == 'api_key'

def test_detects_pem_private_key():
    pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'
    f = find_secrets(pem)
    assert len(f) == 1 and f[0].kind == 'pem_private_key' and f[0].is_private_key

def test_detects_env_secret_assignment():
    f = find_secrets('HELIUS_API_KEY=abcd1234efgh5678')
    assert len(f) == 1 and f[0].kind == 'env_secret'

def test_allow_comment_suppresses_line():
    line = 'OPENAI=sk-' + 'A' * 32 + '  # secret-scrub: allow'
    assert find_secrets(line) == []

def test_clean_text_has_no_findings():
    assert find_secrets('def add(a, b):\n    return a + b\n') == []

def test_whole_file_secret_by_filename():
    assert is_whole_file_secret('anything', 'bot.keypair.json') is True
    assert is_whole_file_secret('x=1', '.env') is True

def test_whole_file_secret_by_content():
    assert is_whole_file_secret(SOLANA_KEYPAIR, 'wallet.json') is True

def test_normal_file_is_not_whole_file_secret():
    assert is_whole_file_secret('print("hello")', 'app.py') is False
