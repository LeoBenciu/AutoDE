#!/usr/bin/env python3
"""
Generate embeddings for Romanian Chart of Accounts.
This script should be run once to create the embeddings file,
and then re-run only when the Chart of Accounts is updated.
"""

import sys
import os
import json
import re
from openai import OpenAI
from typing import Dict, List, Tuple
import time

# Add parent directory to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def get_romanian_chart_of_accounts() -> str:
    """Load the Romanian Chart of Accounts from the package data file.

    Same canonical source as main.get_romanian_chart_of_accounts().
    """
    data_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        'data',
        'romanian_chart_of_accounts.txt',
    )
    with open(data_path, 'r', encoding='utf-8') as f:
        content = f.read()
    if len(content) < 1000:
        raise RuntimeError(
            f"Romanian Chart of Accounts at {data_path} is truncated "
            f"({len(content)} chars); refusing to proceed."
        )
    print(f"✅ Loaded Chart of Accounts ({len(content)} chars) from {data_path}", file=sys.stderr)
    return content


def parse_chart_of_accounts(chart_text: str) -> List[Tuple[str, str, str]]:
    """
    Parse the chart of accounts text into structured data.

    Returns:
        List of tuples: (account_code, description, full_context)
    """
    accounts = []
    lines = chart_text.split('\n')

    # Track hierarchy for context
    current_class = ""
    current_group = ""
    current_subgroup = ""

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Match different patterns:
        # Clasa X - Description
        if stripped.startswith('Clasa '):
            current_class = stripped
            continue

        # XX. Description (group level like "10. Capital si rezerve")
        group_match = re.match(r'^(\d{1,2})\.\s+(.+)$', stripped)
        if group_match:
            code = group_match.group(1)
            desc = group_match.group(2)
            current_group = f"{code}. {desc}"

            # This is a group, save it as an account
            full_context = f"{current_class} > {current_group}"
            accounts.append((code, desc, full_context))
            continue

        # XXX. Description (subgroup like "101. Capital")
        subgroup_match = re.match(r'^(\d{3})\.\s+(.+)$', stripped)
        if subgroup_match:
            code = subgroup_match.group(1)
            desc = subgroup_match.group(2)
            current_subgroup = f"{code}. {desc}"

            # Save as account
            full_context = f"{current_class} > {current_group} > {current_subgroup}"
            accounts.append((code, desc, full_context))
            continue

        # XXXX. Description (A) or (P) or (A/P) - detailed account
        detail_match = re.match(r'^(\d{4})\.\s+(.+?)(?:\s*\([AP/]+\))?$', stripped)
        if detail_match:
            code = detail_match.group(1)
            desc = detail_match.group(2).strip()

            # Save as account with full hierarchy
            full_context = f"{current_class} > {current_group} > {current_subgroup} > {code}. {desc}"
            accounts.append((code, desc, full_context))
            continue

    print(f"✅ Parsed {len(accounts)} accounts from Chart of Accounts", file=sys.stderr)
    return accounts


def generate_embeddings(accounts: List[Tuple[str, str, str]]) -> Dict:
    """
    Generate embeddings for each account using OpenAI's text-embedding-3-small.

    Args:
        accounts: List of (account_code, description, full_context)

    Returns:
        Dictionary mapping account codes to their embeddings and metadata
    """
    client = OpenAI()
    embeddings_data = {}

    try:
        from model_config import get_embedding_model
    except ImportError:
        from .model_config import get_embedding_model
    embedding_model = get_embedding_model()

    print(f"\n🚀 Generating embeddings for {len(accounts)} accounts...", file=sys.stderr)
    print(f"   Model: {embedding_model}", file=sys.stderr)

    batch_size = 100  # Process in batches to show progress
    total_batches = (len(accounts) + batch_size - 1) // batch_size

    for batch_idx in range(0, len(accounts), batch_size):
        batch = accounts[batch_idx:batch_idx + batch_size]
        current_batch = (batch_idx // batch_size) + 1

        print(f"\n📦 Processing batch {current_batch}/{total_batches} ({len(batch)} accounts)...", file=sys.stderr)

        for code, desc, full_context in batch:
            try:
                # Create rich text for embedding that includes:
                # 1. Account code
                # 2. Description
                # 3. Full hierarchical context
                text_for_embedding = f"{code} - {desc}\nContext: {full_context}"

                response = client.embeddings.create(
                    model=embedding_model,
                    input=text_for_embedding
                )

                # Store embedding and metadata
                embeddings_data[code] = {
                    'code': code,
                    'description': desc,
                    'full_context': full_context,
                    'embedding': response.data[0].embedding,
                    'text': text_for_embedding
                }

                # Small delay to avoid rate limits (though unlikely with embeddings)
                time.sleep(0.01)

            except Exception as e:
                print(f"❌ Error generating embedding for {code}: {e}", file=sys.stderr)
                continue

        print(f"   ✅ Completed batch {current_batch}/{total_batches}", file=sys.stderr)

    print(f"\n✅ Successfully generated embeddings for {len(embeddings_data)} accounts!", file=sys.stderr)
    return embeddings_data


def save_embeddings(embeddings_data: Dict, output_path: str):
    """Save embeddings to JSON file."""
    # Create directory if it doesn't exist
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(embeddings_data, f, ensure_ascii=False, indent=2)

    # Calculate file size
    file_size = os.path.getsize(output_path)
    file_size_kb = file_size / 1024
    file_size_mb = file_size_kb / 1024

    if file_size_mb > 1:
        size_str = f"{file_size_mb:.2f} MB"
    else:
        size_str = f"{file_size_kb:.2f} KB"

    print(f"\n💾 Embeddings saved to: {output_path}", file=sys.stderr)
    print(f"   File size: {size_str}", file=sys.stderr)
    print(f"   Total accounts: {len(embeddings_data)}", file=sys.stderr)


def main():
    """Main function to generate and save embeddings."""
    print("=" * 80, file=sys.stderr)
    print("🎯 Romanian Chart of Accounts - Embeddings Generator", file=sys.stderr)
    print("=" * 80, file=sys.stderr)

    # Check for OpenAI API key
    if not os.getenv('OPENAI_API_KEY'):
        print("\n❌ ERROR: OPENAI_API_KEY environment variable not set!", file=sys.stderr)
        print("   Please set it with: export OPENAI_API_KEY='your-key-here'", file=sys.stderr)
        sys.exit(1)

    try:
        # Step 1: Load Chart of Accounts
        print("\n📖 Step 1: Loading Romanian Chart of Accounts...", file=sys.stderr)
        chart_text = get_romanian_chart_of_accounts()

        # Step 2: Parse accounts
        print("\n📋 Step 2: Parsing accounts...", file=sys.stderr)
        accounts = parse_chart_of_accounts(chart_text)

        # Show sample accounts
        print("\n📝 Sample accounts:", file=sys.stderr)
        for code, desc, context in accounts[:5]:
            print(f"   {code}: {desc}", file=sys.stderr)
        print("   ...", file=sys.stderr)

        # Step 3: Generate embeddings
        print("\n🤖 Step 3: Generating embeddings with OpenAI...", file=sys.stderr)
        embeddings_data = generate_embeddings(accounts)

        # Step 4: Save to file
        print("\n💾 Step 4: Saving embeddings...", file=sys.stderr)

        # Save to data directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        data_dir = os.path.join(script_dir, 'data')
        output_path = os.path.join(data_dir, 'chart_embeddings.json')

        save_embeddings(embeddings_data, output_path)

        # Success!
        print("\n" + "=" * 80, file=sys.stderr)
        print("✅ SUCCESS! Embeddings generated and saved.", file=sys.stderr)
        print("=" * 80, file=sys.stderr)
        print(f"\n📍 File location: {output_path}", file=sys.stderr)
        print(f"📊 Total accounts: {len(embeddings_data)}", file=sys.stderr)
        print(f"💰 Estimated cost: ~$0.0002 (one-time)", file=sys.stderr)
        print("\n🚀 You can now use account_selector.py to find relevant accounts!", file=sys.stderr)
        print("=" * 80, file=sys.stderr)

    except Exception as e:
        print(f"\n❌ ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
