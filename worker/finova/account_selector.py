"""
Account Selector using RAG (Retrieval-Augmented Generation).

This module selects the most relevant accounts from the Romanian Chart of Accounts
based on document content, using semantic similarity with embeddings.
"""

import sys
import os
import json
import numpy as np
from openai import OpenAI
from typing import List, Tuple, Dict, Optional
import time

# Cache for embeddings (loaded once)
_embeddings_cache: Optional[Dict] = None
_embedding_vectors_cache: Optional[Dict[str, np.ndarray]] = None


def load_embeddings() -> Dict:
    """
    Load pre-computed embeddings from JSON file.

    Returns:
        Dictionary mapping account codes to their embeddings and metadata
    """
    global _embeddings_cache, _embedding_vectors_cache

    # Return cached if available
    if _embeddings_cache is not None:
        return _embeddings_cache

    # Find embeddings file
    script_dir = os.path.dirname(os.path.abspath(__file__))
    embeddings_path = os.path.join(script_dir, 'data', 'chart_embeddings.json')

    if not os.path.exists(embeddings_path):
        raise FileNotFoundError(
            f"❌ Embeddings file not found at: {embeddings_path}\n"
            f"Please run embeddings_generator.py first to generate embeddings."
        )

    print(f"📖 Loading embeddings from: {embeddings_path}", file=sys.stderr)

    with open(embeddings_path, 'r', encoding='utf-8') as f:
        _embeddings_cache = json.load(f)

    # Sanity guard: this file has previously regressed to a degenerate placeholder
    # set (250 entries, null descriptions, only classes 4/5/6 — so revenue 7xx,
    # inventory 3xx and asset 2xx codes could NEVER be retrieved and the ranking was
    # pure noise). Fail loudly so callers fall back to a known generic list instead
    # of silently ranking on garbage. Regenerate with embeddings_generator.py.
    _codes = list(_embeddings_cache.keys())
    _classes = {c[0] for c in _codes if c and c[0].isdigit()}
    if len(_embeddings_cache) < 500 or '7' not in _classes:
        raise RuntimeError(
            f"chart_embeddings.json looks degenerate: {len(_embeddings_cache)} accounts, "
            f"classes present={sorted(_classes)} (expected >=500 spanning classes 1-9, incl. "
            f"7xx revenue). Re-run embeddings_generator.py to regenerate."
        )

    # Pre-convert embeddings to numpy arrays for faster computation
    _embedding_vectors_cache = {}
    for code, data in _embeddings_cache.items():
        _embedding_vectors_cache[code] = np.array(data['embedding'])

    print(f"✅ Loaded embeddings for {len(_embeddings_cache)} accounts", file=sys.stderr)

    return _embeddings_cache


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """
    Calculate cosine similarity between two vectors.

    Args:
        a: First vector
        b: Second vector

    Returns:
        Similarity score between 0 and 1 (1 = identical, 0 = completely different)
    """
    dot_product = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)

    if norm_a == 0 or norm_b == 0:
        return 0.0

    return dot_product / (norm_a * norm_b)


def _clamp_to_token_budget(text: str, max_tokens: int) -> str:
    """Hard-truncate text to at most max_tokens for the embedding model. Uses
    tiktoken (cl100k_base, the text-embedding-3 tokenizer) when available; falls
    back to a conservative 2.5 chars/token estimate so dense numeric text can't
    overflow the 8192-token API cap. Never raises."""
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        toks = enc.encode(text)
        if len(toks) <= max_tokens:
            return text
        return enc.decode(toks[:max_tokens])
    except Exception:
        max_chars = int(max_tokens * 2.5)
        return text if len(text) <= max_chars else text[:max_chars]


def get_document_embedding(document_text: str, client: Optional[OpenAI] = None) -> np.ndarray:
    """
    Generate embedding for document text.

    Args:
        document_text: Text content of the document
        client: Optional OpenAI client (creates new one if not provided)

    Returns:
        Embedding vector as numpy array
    """
    if client is None:
        client = OpenAI()

    # Limit text length to avoid the 8192-token cap of text-embedding-3-small.
    # Number/code-dense statements (UniCredit bank PDFs) tokenize far worse than
    # the ~4 chars/token rule of thumb — 30K chars overflowed 8192 and 400'd the
    # whole call (→ 0 relevant accounts). Take beginning+end (the parts that carry
    # vendor/document identity), keep a conservative char budget, then hard-clamp
    # by real token count with tiktoken when available.
    max_chars = 16000
    if len(document_text) > max_chars:
        half = max_chars // 2
        document_text = document_text[:half] + "\n...\n" + document_text[-half:]
    document_text = _clamp_to_token_budget(document_text, 8000)

    try:
        from model_config import get_embedding_model
    except ImportError:
        from .model_config import get_embedding_model

    response = client.embeddings.create(
        model=get_embedding_model(),
        input=document_text
    )

    return np.array(response.data[0].embedding)


def select_relevant_accounts(
    document_text: str,
    top_k: int = 20,
    min_similarity: float = 0.3,
    client: Optional[OpenAI] = None
) -> str:
    """
    Select the most relevant accounts for a document using semantic similarity.

    Args:
        document_text: Text content of the document
        top_k: Number of top accounts to return (default: 20)
        min_similarity: Minimum similarity threshold (default: 0.3)
        client: Optional OpenAI client

    Returns:
        Formatted string with relevant accounts (ready to include in prompt)
    """
    try:
        # Load embeddings
        embeddings_data = load_embeddings()

        if not embeddings_data:
            raise ValueError("No embeddings available")

        # Get document embedding
        if client is None:
            client = OpenAI()

        print(f"🔍 Generating document embedding...", file=sys.stderr)
        doc_embedding = get_document_embedding(document_text, client)

        # Calculate similarity with each account
        print(f"📊 Calculating similarities with {len(embeddings_data)} accounts...", file=sys.stderr)
        similarities: List[Tuple[str, str, str, float]] = []

        for code, data in embeddings_data.items():
            account_embedding = _embedding_vectors_cache[code]
            similarity = cosine_similarity(doc_embedding, account_embedding)

            # Only include accounts above minimum similarity threshold
            if similarity >= min_similarity:
                # Safely get description with fallback
                description = data.get('description', f'Account {code}')
                full_context = data.get('full_context', '')

                similarities.append((
                    code,
                    description,
                    full_context,
                    similarity
                ))

        # Sort by similarity (highest first)
        similarities.sort(key=lambda x: x[3], reverse=True)

        # Get top K accounts
        top_accounts = similarities[:top_k]

        if not top_accounts:
            print(f"⚠️  WARNING: No accounts found with similarity >= {min_similarity}", file=sys.stderr)
            print(f"🚨 TOKEN CONSUMPTION FIX: Skipping recursive call to prevent token waste", file=sys.stderr)
            print(f"💰 SAVED: Avoiding expensive recursive embedding call", file=sys.stderr)
            # CRITICAL FIX: Don't recurse, just return fallback accounts
            return get_fallback_accounts(top_k)

        # Log selected accounts
        print(f"\n✅ Selected {len(top_accounts)} most relevant accounts:", file=sys.stderr)
        for i, (code, desc, context, sim) in enumerate(top_accounts[:5], 1):
            print(f"   {i}. {code} - {desc} (similarity: {sim:.3f})", file=sys.stderr)
        if len(top_accounts) > 5:
            print(f"   ... and {len(top_accounts) - 5} more", file=sys.stderr)

        # Format for prompt
        formatted_accounts = format_accounts_for_prompt(top_accounts)

        return formatted_accounts

    except Exception as e:
        # Fallback: return error message
        error_msg = f"ERROR in select_relevant_accounts: {str(e)}"
        print(f"❌ {error_msg}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)

        # Return a minimal fallback (most common accounts)
        return get_fallback_accounts()


def format_accounts_for_prompt(accounts: List[Tuple[str, str, str, float]]) -> str:
    """
    Format selected accounts for inclusion in AI prompt.

    Args:
        accounts: List of (code, description, full_context, similarity)

    Returns:
        Formatted string ready for prompt
    """
    lines = ["RELEVANT ROMANIAN CHART OF ACCOUNTS (Selected for this document):\n"]

    for code, desc, full_context, similarity in accounts:
        # Include code, description, and a simplified context
        lines.append(f"  {code}. {desc}")

        # Optionally include context hierarchy for better understanding
        # (keeping it concise to save tokens)
        context_parts = full_context.split(' > ')
        if len(context_parts) > 1:
            # Show only the immediate parent group
            parent = context_parts[-2] if len(context_parts) >= 2 else context_parts[0]
            lines.append(f"      (Category: {parent})")

    return "\n".join(lines)


def get_fallback_accounts(top_k: int = 20) -> str:
    """
    Return a minimal set of common accounts as fallback.
    Used when embeddings are not available or selection fails.
    top_k is accepted for API compatibility (fixed list is returned).
    """
    return """
RELEVANT ROMANIAN CHART OF ACCOUNTS (Fallback - Most Common):

  401. Furnizori
  411. Clienti
  512. Conturi curente la banci
  531. Casa
  628. Alte servicii externe
  624. Transporturi de bunuri si persoane
  611. Cheltuieli cu intretinerea si reparatiile
  612. Cheltuieli cu redeventele, locatiile de gestiune si chiriile
  704. Venituri din lucrari
  707. Venituri din vanzarea marfurilor
  301. Materii prime
  302. Materiale consumabile
  371. Marfuri
  4426. TVA deductibila
  4427. TVA colectata
  471. Cheltuieli inregistrate in avans
  472. Venituri inregistrate in avans
  121. Profit sau pierdere
  """


def select_relevant_accounts_with_cache(
    document_text: str,
    document_hash: str,
    top_k: int = 20
) -> str:
    """
    Select relevant accounts with caching support.

    Args:
        document_text: Text content of the document
        document_hash: Hash of the document (for caching)
        top_k: Number of top accounts to return

    Returns:
        Formatted string with relevant accounts
    """
    # TODO: Implement caching of document embeddings to avoid regenerating
    # For now, just call select_relevant_accounts directly
    return select_relevant_accounts(document_text, top_k=top_k)


# Example usage and testing
if __name__ == "__main__":
    print("=" * 80, file=sys.stderr)
    print("🧪 Account Selector - Test Mode", file=sys.stderr)
    print("=" * 80, file=sys.stderr)

    # Test with sample invoice text
    sample_text = """
    FACTURA FISCALA NR. 12345

    FURNIZOR:
    TIMELY SOFTWARE SOLUTIONS SRL
    CUI: RO38963008

    CUMPARATOR:
    M & D RETAIL MILITARI SRL
    CUI: RO12345678

    Descriere: Servicii dezvoltare software
    Valoare: 10,000 RON
    TVA 19%: 1,900 RON
    TOTAL: 11,900 RON
    """

    try:
        print("\n📄 Testing with sample invoice...", file=sys.stderr)
        print(f"   Text length: {len(sample_text)} chars", file=sys.stderr)

        relevant_accounts = select_relevant_accounts(sample_text, top_k=10)

        print("\n📋 Selected accounts:", file=sys.stderr)
        print(relevant_accounts, file=sys.stderr)

        print("\n✅ Test completed successfully!", file=sys.stderr)

    except Exception as e:
        print(f"\n❌ Test failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
