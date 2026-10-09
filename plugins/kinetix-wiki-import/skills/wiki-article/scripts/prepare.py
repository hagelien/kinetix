#!/usr/bin/env python3
"""Validate a semantically authored draft and account for every source block."""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from inventory import inventory

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate(bundle):
    schema = load(Path(__file__).resolve().parent.parent/'references/schema.json')
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(bundle)
    sources, sections = bundle['sources'], bundle['sections']
    facts = [f for s in sections for f in s['facts']]
    require(1 <= len(facts) <= 500, 'Expected 1–500 facts')
    for values, name in [([s['key'] for s in sources], 'source'), ([s['key'] for s in sections], 'section'),
                         ([s['sectionId'] for s in sections if 'sectionId' in s], 'sectionId'),
                         ([f['key'] for f in facts], 'fact')]:
        require(len(values) == len(set(values)), f'Duplicate {name} key')
    keys = {s['key'] for s in sources}
    for source in sources:
        pattern = {'doi': r'10\.\d{4,9}/\S+', 'pmid': r'[1-9]\d{0,11}', 'url': r'https?://[^\s]+'}[source['type']]
        require(re.fullmatch(pattern, source['identifier'], re.I), f'Invalid identifier: {source["key"]}')
    for fact in facts:
        require(set(fact['sourceKeys']) <= keys, f'Unknown source: {fact["key"]}')
        require(len(fact['sourceKeys']) == len(set(fact['sourceKeys'])), 'Duplicate fact source')
        require(all(e['sourceKey'] in fact['sourceKeys'] for e in fact.get('evidence', [])), 'Uncited evidence')
    require(all(b['sectionKey'] in {s['key'] for s in sections} for b in bundle.get('blockedCandidates', [])), 'Unknown blocked section')

def main():
    parser = argparse.ArgumentParser()
    for arg in ['article', 'inventory', 'draft', 'output']:
        parser.add_argument('--'+arg, required=True)
    args = parser.parse_args()
    article = Path(args.article).read_bytes()
    units = load(args.inventory)
    require(units == inventory(article.decode('utf-8')), 'Inventory does not match article')
    draft = load(args.draft)
    covered, unit_ids, audit = set(), {u['id'] for u in units}, []
    for section in draft['sections']:
        for fact in section['facts']:
            inputs = fact.pop('inputUnits', [])
            require(inputs and set(inputs) <= unit_ids, f'Missing/invalid inputUnits on {fact["key"]}')
            covered.update(inputs)
            audit.append({'factKey': fact['key'], 'sectionKey': section['key'], 'inputUnits': inputs})
    for blocked in draft.get('blockedCandidates', []):
        inputs = blocked.pop('inputUnits', [])
        require(inputs and set(inputs) <= unit_ids, 'Missing/invalid blocked inputUnits')
        covered.update(inputs)
        audit.append({'blocked': blocked, 'inputUnits': inputs})
    excluded, excluded_ids = draft.pop('excludedUnits', []), set()
    for item in excluded:
        require(item['unitId'] in unit_ids and item.get('reason', '').strip(), 'Invalid excluded unit')
        require(item['unitId'] not in covered, 'Unit both excluded and covered')
        require(item['unitId'] not in excluded_ids, 'Duplicate excluded unit')
        excluded_ids.add(item['unitId'])
    require(covered | excluded_ids == unit_ids, f'Unaccounted input units: {sorted(unit_ids-covered-excluded_ids)}')
    digest = hashlib.sha256(article).hexdigest()
    draft.update(schemaVersion='kinetix-wiki-article-v1', articleDigest=digest,
                 idempotencyKey=f'wiki-article:{draft["page"]["slug"][:100]}:{digest[:32]}',
                 createdAt=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))
    validate(draft)
    output = Path(args.output)
    output.write_text(json.dumps(draft, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    report = {'articleDigest': digest, 'inputUnitCount': len(units),
              'factCount': sum(len(s['facts']) for s in draft['sections']),
              'sectionCount': len(draft['sections']), 'blockedCount': len(draft.get('blockedCandidates', [])),
              'excludedUnits': excluded, 'mapping': audit,
              'validation': 'Structure and input-unit coverage only; scientific and semantic review still required.'}
    output.with_suffix('.audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k not in ['mapping', 'excludedUnits']}, ensure_ascii=False))

if __name__ == '__main__':
    main()
