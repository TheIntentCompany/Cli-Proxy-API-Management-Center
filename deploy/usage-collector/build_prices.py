#!/usr/bin/python3 -I
"""Reduce an already downloaded LiteLLM document. This script never fetches URLs."""
import argparse
import json
import math
from pathlib import Path

SOURCE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
PROVIDERS = {'anthropic', 'openai', 'xai', 'gemini'}


def build(document, fetched_at):
    models = {}
    for name, entry in document.items():
        if not isinstance(entry, dict):
            continue
        provider = entry.get('litellm_provider')
        # Responses models include the first-party Codex chat models.
        if provider not in PROVIDERS or entry.get('mode') not in {'chat', 'responses'}:
            continue
        if '/' in name and name.split('/', 1)[0] != provider:
            continue
        if name.startswith('ft:'):
            continue
        fields = {k: v for k, v in entry.items()
                  if ('cost_per_token' in k or k.startswith('cache_'))
                  and isinstance(v, (int, float)) and not isinstance(v, bool)
                  and math.isfinite(v) and v >= 0}
        if not {'input_cost_per_token', 'output_cost_per_token'} <= fields.keys():
            continue
        models[name.strip().lower()] = fields
    return {'source': {'name': 'LiteLLM', 'url': SOURCE_URL, 'fetched_at': fetched_at},
            'models': dict(sorted(models.items()))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', default='/tmp/litellm/prices.json')
    parser.add_argument('--output', default=str(Path(__file__).with_name('prices.json')))
    parser.add_argument('--fetched-at', default='2026-11-14')
    args = parser.parse_args()
    with open(args.input, encoding='utf-8') as source:
        document = build(json.load(source), args.fetched_at)
    Path(args.output).write_text(json.dumps(document, indent=2, sort_keys=True) + '\n')
    print(f"Wrote {len(document['models'])} models")


if __name__ == '__main__':
    main()
