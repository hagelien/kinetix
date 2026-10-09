#!/usr/bin/env python3
"""List Markdown text blocks and table rows for coverage accounting."""
import json
import re
import sys
from pathlib import Path

def inventory(text):
    units, buffer = [], []
    heading = ['Sammendrag']
    table_header = None
    def add(value, kind='paragraph'):
        if value.strip():
            units.append({'id': f'U{len(units)+1:04d}', 'headingPath': heading.copy(),
                          'kind': kind, 'text': value.strip(),
                          **({'tableHeader': table_header} if kind == 'table-row' else {})})
    def flush():
        if buffer:
            add('\n'.join(buffer))
            buffer.clear()
    for line in text.splitlines():
        h = re.match(r'^(#{1,6})\s+(.+)$', line)
        if h:
            flush()
            if h[2].strip().lower() in {'referanser', 'kilder', 'references', 'bibliography'}:
                break
            level = len(h[1])
            if level == 1:
                continue
            heading = heading[:max(0, level-2)] + [h[2].strip()]
            table_header = None
        elif line.strip().startswith('|'):
            flush()
            if re.fullmatch(r'[|:\-\s]+', line):
                continue
            if table_header is None:
                table_header = line.strip()
            else:
                add(line, 'table-row')
        elif not line.strip():
            flush()
            table_header = None
        else:
            if re.match(r'^\s*(?:[-*]|\d+\.)\s+', line):
                flush()
            buffer.append(line)
    flush()
    return units

if __name__ == '__main__':
    source, target = map(Path, sys.argv[1:3])
    units = inventory(source.read_text(encoding='utf-8'))
    target.write_text(json.dumps(units, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f'{len(units)} input units → {target}')
