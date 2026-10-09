#!/usr/bin/env python3
"""Read public Kinetix headings and capabilities. Never writes remotely."""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

def get(path):
    request = urllib.request.Request('https://www.kinetix.no'+path, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def text(node):
    return node.get('text', '') + ''.join(text(n) for n in node.get('content', []))

if __name__ == '__main__':
    slug, output = sys.argv[1:3]
    data = get('/api/wiki/pages?slug='+urllib.parse.quote(slug, safe=''))
    page = data.get('page', data)
    if page.get('slug') != slug or page.get('pageType') != 'topic':
        raise SystemExit('Expected an existing topic page with the requested slug')
    try:
        formats = get('/api/conversation-ingestion?action=formats').get('schemaVersions', [])
    except Exception as error:
        formats = []
        print(f'Import capability unavailable: {error}', file=sys.stderr)
    result = {'page': {'slug': slug, 'id': page['id']}, 'title': page['title'],
              'importSupported': 'kinetix-wiki-article-v1' in formats,
              'sections': [{'sectionId': n['attrs']['sectionId'], 'heading': text(n), 'level': n['attrs']['level']}
                           for n in (page.get('content') or {}).get('content', [])
                           if n.get('type') == 'heading' and n.get('attrs', {}).get('sectionId')]}
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
