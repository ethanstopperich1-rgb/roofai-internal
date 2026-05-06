"""One-shot env file fixer. Strips wrapping double-quotes and trailing
literal backslash-n sequences from these specific keys. Idempotent.

Run: python scripts/fix-env-quotes.py .env.local
"""
import sys

KEYS = {
    'ANTHROPIC_API_KEY','ATTOM_API_KEY','GCP_SERVICE_ACCOUNT_KEY',
    'GEMINI_API_KEY','GOOGLE_SERVER_KEY','NEXT_PUBLIC_GOOGLE_MAPS_KEY',
    'REPLICATE_API_TOKEN','ROBOFLOW_API_KEY',
}

# Bytes for: backslash + lowercase n
LITERAL_BS_N = bytes([0x5c, 0x6e])
QUOTE = bytes([0x22])

def fix_value(v: bytes) -> bytes:
    # Strip wrapping double-quotes
    if len(v) >= 2 and v[:1] == QUOTE and v[-1:] == QUOTE:
        v = v[1:-1]
    # Strip ALL trailing literal backslash-n sequences
    while v.endswith(LITERAL_BS_N):
        v = v[:-2]
    return v

path = sys.argv[1] if len(sys.argv) > 1 else '.env.local'
with open(path, 'rb') as f:
    raw = f.read()

# Preserve original line endings — split on real newlines only
lines = raw.split(b'\n')
out = []
report = []
for line in lines:
    if b'=' in line:
        idx = line.index(b'=')
        k = line[:idx].decode('ascii', errors='replace')
        v = line[idx+1:]
        if k in KEYS:
            new_v = fix_value(v)
            report.append(f'{k}: {len(v)} -> {len(new_v)} bytes')
            line = line[:idx+1] + new_v
    out.append(line)

with open(path, 'wb') as f:
    f.write(b'\n'.join(out))

for r in report:
    print(r)
