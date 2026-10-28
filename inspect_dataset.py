import sys
import json

sys.stdout.reconfigure(encoding='utf-8')

file_path = r"d:\fpt\futuretrace_server\train_data_diverse_3000.jsonl"
with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

import re
fixed = re.sub(r'\}\s*\{\s*"system"', '}\n{"system"', text)
raw_lines = [l.strip() for l in fixed.split("\n") if l.strip()]

line = raw_lines[432]
print("End of line 432 repr:", repr(line[-30:]))
try:
    json.loads(line)
except Exception as e:
    print("Exception:", type(e), e)
    # Let's inspect where json.loads stopped
    import json.decoder
    decoder = json.JSONDecoder()
    obj, end = decoder.raw_decode(line)
    print("raw_decode succeeded up to index:", end)
    print("Remaining string after index", end, ":", repr(line[end:]))
