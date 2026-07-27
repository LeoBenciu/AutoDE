import sys
import warnings
import base64
import os
import json
import csv
import logging
import gc
import tempfile
import tracemalloc
import traceback
import hashlib
import time
from typing import Dict, Any, Optional, List
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime

PROCESSING_PHASE_ENV = os.getenv('PROCESSING_PHASE', '').strip()
try:
    CURRENT_PHASE = int(PROCESSING_PHASE_ENV) if PROCESSING_PHASE_ENV != '' else None
except Exception:
    CURRENT_PHASE = None

# Token monitoring is extremely noisy/expensive. Keep it OFF by default in production,
# and ALWAYS disable it for Phase 0 (categorization) to avoid timeouts.
TOKEN_MONITORING_ENABLED = os.getenv('FINOVA_TOKEN_MONITORING', 'false').lower() == 'true'
if CURRENT_PHASE == 0:
    TOKEN_MONITORING_ENABLED = False

if TOKEN_MONITORING_ENABLED:
    try:
        from token_monitor import start_token_monitoring, stop_token_monitoring, log_function_call, monitor_openai_call
        from monitor_tokens import start_realtime_monitoring, stop_realtime_monitoring, log_realtime_token_usage, patch_openai_client
        print("✅ Token monitoring enabled", file=sys.stderr)
        # Patch OpenAI client for real-time monitoring
        if patch_openai_client():
            print("✅ OpenAI client patched for real-time token monitoring", file=sys.stderr)
        else:
            print("⚠️  OpenAI client patching failed", file=sys.stderr)
    except Exception as e:
        TOKEN_MONITORING_ENABLED = False
        print(f"⚠️  Token monitoring disabled (import failed): {e}", file=sys.stderr)

# CRITICAL FIX: Check if AI is disabled
if os.getenv('FINOVA_AI_ENABLED', 'true').lower() == 'false':
    print("🚨 AI DISABLED: Skipping all AI processing to prevent token consumption", file=sys.stderr)
    print("🚨 Set FINOVA_AI_ENABLED=true to re-enable AI processing", file=sys.stderr)
    result = {
        "error": "AI processing disabled to prevent token consumption",
        "details": "Set FINOVA_AI_ENABLED=true to re-enable AI processing"
    }
    print(json.dumps(result))
    sys.exit(0)

_log_level = os.getenv('FINOVA_PY_LOG_LEVEL', '').upper().strip()
if not _log_level:
    # Default quieter logs in production / render
    _log_level = 'WARNING' if (os.getenv('NODE_ENV') == 'production' or os.getenv('RENDER')) else 'DEBUG'
logging.basicConfig(
    level=getattr(logging, _log_level, logging.WARNING),
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stderr)]
)

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

try:
    from crew import FirstCrewFinova
    print("Successfully imported FirstCrewFinova", file=sys.stderr)
except Exception as e:
    print(f"ERROR: Failed to import FirstCrewFinova: {str(e)}", file=sys.stderr)
    print(f"Traceback: {traceback.format_exc()}", file=sys.stderr)
    sys.exit(1)

# Import RAG account selector
try:
    from account_selector import select_relevant_accounts
    RAG_ENABLED = True
    print("✅ RAG account selector imported successfully", file=sys.stderr)
except Exception as e:
    RAG_ENABLED = False
    print(f"⚠️ RAG account selector not available: {e}", file=sys.stderr)

def filter_accounts_by_class(accounts_str: str, allowed_classes: List[str]) -> str:
    """
    Filter accounts string to only include accounts from specified classes.

    Args:
        accounts_str: Formatted accounts string from select_relevant_accounts
        allowed_classes: List of account class prefixes (e.g., ['6', '7'] for expenses and revenues)

    Returns:
        Filtered accounts string with only accounts from allowed classes
    """
    if not accounts_str or not accounts_str.strip():
        return ""

    lines = accounts_str.split('\n')
    filtered_lines = [lines[0]]  # Keep header line

    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue

        # Extract account code (format: "  XXX. Description" or "  XXX Description")
        # Account codes are 3-4 digits, optionally followed by a dot
        import re
        match = re.match(r'\s*(\d{3,4})\.?\s+', line)
        if match:
            account_code = match.group(1)
            # Check if first digit matches any allowed class
            if account_code[0] in allowed_classes:
                filtered_lines.append(line)

    return '\n'.join(filtered_lines) if len(filtered_lines) > 1 else ""
    RAG_ENABLED = False
    print(f"⚠️  RAG not available (will use full chart): {str(e)}", file=sys.stderr)


def get_romanian_chart_of_accounts() -> str:
    """Load the Romanian Chart of Accounts from the package data file.

    The .txt is the canonical source for both the Python agents and the
    TypeScript server (which reads the same file). No silent fallback: if
    the file is missing or truncated, fail loudly. A degraded COA would
    silently hurt extraction quality in ways only visible weeks later in
    user corrections.
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
    return content


def validate_processed_data(data: dict, expected_doc_type: str = None) -> tuple[bool, list[str]]:
    """Validate that processed data contains minimum required fields."""
    errors = []

    if not data or not isinstance(data, dict):
        errors.append("Invalid data structure")
        return False, errors

    if not data.get('document_type'):
        errors.append("Missing document_type")
        return False, errors

    # Enhanced validation for invoices to prevent empty responses
    if data.get('document_type', '').lower() == 'invoice':
        # Check for critical invoice fields
        critical_fields = ['vendor', 'buyer', 'total_amount', 'document_date']
        missing_critical = [field for field in critical_fields if not data.get(field)]

        if missing_critical:
            print(f"WARNING: Missing critical invoice fields: {missing_critical}", file=sys.stderr)
            # Don't fail validation for missing fields, just warn
            errors.append(f"Missing critical fields: {', '.join(missing_critical)}")

        # Ensure line_items is always an array, even if empty
        if 'line_items' not in data:
            data['line_items'] = []
            print("WARNING: No line_items found, setting empty array", file=sys.stderr)
        elif not isinstance(data.get('line_items'), list):
            data['line_items'] = []
            print("WARNING: line_items is not an array, setting empty array", file=sys.stderr)

    return True, errors

def create_fallback_response(doc_type: str = "Unknown") -> dict:
    """Create a minimal fallback response when processing fails."""
    return {
        "document_type": doc_type,
        "document_date": "",
        "vendor": "",
        "buyer": "",
        "total_amount": 0,
        "vat_amount": 0,
        "currency": "RON",
        "line_items": [] if doc_type.lower() == 'invoice' else None,
        "transactions": [] if doc_type.lower() == 'bank statement' else None,
        "duplicate_detection": {
            "is_duplicate": False,
            "duplicate_matches": [],
            "document_hash": "",
            "confidence": 0.0
        },
        "compliance_validation": {
            "compliance_status": "PENDING",
            "overall_score": 0.0,
            "validation_rules": {"ro": [], "en": []},
            "errors": {"ro": ["Procesare incompletă - verificați manual"], "en": ["Incomplete processing - please verify manually"]},
            "warnings": {"ro": [], "en": []}
        },
        "confidence": 0.1,
        "processing_status": "FALLBACK"
    }

def test_openai_connection():
    """Test direct OpenAI connection to verify API key."""
    try:
        import openai
        api_key = os.getenv('OPENAI_API_KEY')

        if not api_key:
            print("ERROR: No OpenAI API key found in test_openai_connection", file=sys.stderr)
            return False

        print(
            f"Testing OpenAI API key (length: {len(api_key)}, starts with 'sk-': {api_key.startswith('sk-')})",
            file=sys.stderr,
        )

        try:
            from model_config import get_extraction_llm_model
        except ImportError:
            from .model_config import get_extraction_llm_model
        try:
            from direct_extraction import (
                _is_anthropic_model, _is_gemini_model, _is_openrouter_model)
        except ImportError:
            from .direct_extraction import (
                _is_anthropic_model, _is_gemini_model, _is_openrouter_model)
        extraction_model = get_extraction_llm_model()
        # A non-OpenAI extraction model is routed elsewhere; don't validate it against
        # api.openai.com (400 "invalid model ID"). Key presence is already confirmed,
        # and OpenAI is still used for embeddings.
        if (_is_anthropic_model(extraction_model)
                or _is_gemini_model(extraction_model)
                or _is_openrouter_model(extraction_model)):
            print(f"OpenAI key present; extraction model '{extraction_model}' is a "
                  f"non-OpenAI provider (validated at call time).", file=sys.stderr)
            return True

        client = openai.OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model=extraction_model,
            messages=[{"role": "user", "content": "Say 'API key works'"}],
            max_completion_tokens=10,
            timeout=30
        )

        print(f"OpenAI API test successful: {response.choices[0].message.content}", file=sys.stderr)
        return True
    except Exception as e:
        print(f"ERROR: OpenAI API test failed: {str(e)}", file=sys.stderr)
        print(f"Error type: {type(e).__name__}", file=sys.stderr)
        return False

def check_llm_configuration():
    """Check if LLM is properly configured"""
    openai_api_key = os.getenv('OPENAI_API_KEY')
    anthropic_api_key = os.getenv('ANTHROPIC_API_KEY')

    if not openai_api_key and not anthropic_api_key:
        print("ERROR: No LLM API key found. Please set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable.", file=sys.stderr)
        return False

    if openai_api_key:
        print("OpenAI API key found - using OpenAI models", file=sys.stderr)
        if test_openai_connection():
            print("OpenAI API key verified and working", file=sys.stderr)
            return True
        else:
            print("ERROR: OpenAI API key validation failed", file=sys.stderr)
            return False
    elif anthropic_api_key:
        print("Anthropic API key found - using Claude models", file=sys.stderr)
        return True

    return False

def setup_memory_monitoring():
    """Setup memory monitoring if available."""
    try:
        tracemalloc.start()
        return True
    except Exception:
        return False

def log_memory_usage(label: str):
    """Log current memory usage."""
    try:
        import psutil
        process = psutil.Process(os.getpid())
        memory_info = process.memory_info()
        print(f"{label} - Memory: RSS={memory_info.rss // 1024 // 1024}MB, VMS={memory_info.vms // 1024 // 1024}MB", file=sys.stderr)

        if tracemalloc.is_tracing():
            current, peak = tracemalloc.get_traced_memory()
            print(f"{label} - Traced: Current={current // 1024 // 1024}MB, Peak={peak // 1024 // 1024}MB", file=sys.stderr)
    except ImportError:
        pass
    except Exception as e:
        print(f"Memory logging failed: {e}", file=sys.stderr)

def cleanup_memory():
    """Force garbage collection only. Do not call tracemalloc.clear_traces() — it can block for minutes with large traces."""
    try:
        collected = gc.collect()
        print(f"Garbage collected {collected} objects", file=sys.stderr)
    except Exception as e:
        print(f"Memory cleanup failed: {e}", file=sys.stderr)

def get_existing_articles() -> Dict:
    """Load existing articles with error handling and memory optimization."""
    articles = {}
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        articles_path = os.path.join(script_dir, "articles.csv")

        if not os.path.exists(articles_path):
            articles_path = "articles.csv"

        if not os.path.exists(articles_path):
            print("WARNING: articles.csv not found, using empty articles", file=sys.stderr)
            return {}

        with open(articles_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                articles[row["code"]] = {
                    "name": row["name"],
                    "vat": row["vat"],
                    "unitOfMeasure": row["unitOfMeasure"],
                    "type": row["type"]
                }

        print(f"Loaded {len(articles)} articles", file=sys.stderr)

    except Exception as e:
        print(f"ERROR: Error reading articles.csv: {str(e)}", file=sys.stderr)
        return {}

    return articles

def generate_document_hash(file_path: str) -> str:
    """Canonical document hash: SHA-256 of file content (see doc_hash.py).

    Matches the Node side's Prisma Document.documentHash so exact-duplicate
    detection works, and keys all /tmp caches consistently across processes.
    """
    try:
        from doc_hash import sha256_file
    except ImportError:
        from .doc_hash import sha256_file
    h = sha256_file(file_path)
    if not h:
        print(f"Failed to generate document hash for {file_path}", file=sys.stderr)
    return h

def load_user_corrections(client_company_ein: str, corrections_file_path: str = None) -> List[Dict]:
    """Load user corrections for learning from the corrections file."""
    if not corrections_file_path:
        print(f"⚠️  No corrections file path provided, returning empty list", file=sys.stderr)
        return []

    if not os.path.exists(corrections_file_path):
        print(f"⚠️  Corrections file not found at {corrections_file_path}, returning empty list", file=sys.stderr)
        return []

    try:
        with open(corrections_file_path, 'r', encoding='utf-8') as f:
            corrections = json.load(f)
            print(f"✅ Loaded {len(corrections)} user corrections from file", file=sys.stderr)
            return corrections
    except Exception as e:
        print(f"❌ Failed to load user corrections from {corrections_file_path}: {str(e)}", file=sys.stderr)
        return []

def _sniff_file_suffix(base64_data: str) -> str:
    """Detect the real file type from the decoded magic bytes and return a matching
    suffix.

    Uploads arrive as raw base64 with no filename. Writing every upload as '.pdf'
    (the old hardcoded default) silently broke photo/image uploads — phone and
    WhatsApp captures are JPEG/PNG, but a '.pdf'-named file makes the extension-gated
    pipeline treat them as PDFs: the vision render (pdf2image) and the PDF OCR path
    both fail to parse image bytes, so extraction fell back to empty text-only and
    returned an all-'Unknown'/0 skeleton. The suffix must match the actual bytes
    because direct_extraction._render_doc_images and crew.py's OCR route on it.
    Falls back to '.pdf' only when nothing matches (a real PDF always carries the
    %PDF marker, so it is detected explicitly anyway)."""
    try:
        head = base64.b64decode("".join(base64_data.split())[:64])
    except Exception:
        return ".pdf"
    if head[:4] == b"%PDF":
        return ".pdf"
    if head[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return ".tiff"
    if head[:2] == b"BM":
        return ".bmp"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return ".pdf"


def save_temp_file(base64_data: str) -> str:
    """Save base64 data to a temporary file with error handling."""
    try:
        if not base64_data:
            raise ValueError("Empty base64 data")

        estimated_size = len(base64_data) * 3 // 4
        max_size = 50 * 1024 * 1024

        if estimated_size > max_size:
            raise ValueError(f"File too large: {estimated_size // 1024 // 1024}MB > {max_size // 1024 // 1024}MB")

        suffix = _sniff_file_suffix(base64_data)
        with tempfile.NamedTemporaryFile(mode='wb', suffix=suffix, delete=False) as temp_file:
            chunk_size = 1024 * 1024
            for i in range(0, len(base64_data), chunk_size):
                chunk = base64_data[i:i + chunk_size]
                decoded_chunk = base64.b64decode(chunk)
                temp_file.write(decoded_chunk)

            temp_path = temp_file.name

        print(f"Saved temporary file: {temp_path} ({estimated_size // 1024}KB)", file=sys.stderr)
        return temp_path

    except Exception as e:
        print(f"ERROR: Error saving temporary file: {str(e)}", file=sys.stderr)
        raise

def validate_compliance_output(result):
    """Validate and fix compliance data to ensure bilingual structure"""
    if not result or not isinstance(result, dict):
        return False

    compliance_data = result.get('compliance_validation')
    if not compliance_data:
        return True

    if not isinstance(compliance_data, dict):
        return False

    if 'compliance_status' not in compliance_data:
        return False

    bilingual_fields = ['validation_rules', 'errors', 'warnings']

    for field in bilingual_fields:
        field_data = compliance_data.get(field)

        if field_data is None:
            compliance_data[field] = {'ro': [], 'en': []}
        elif isinstance(field_data, list):
            compliance_data[field] = {'ro': field_data, 'en': field_data}
            print(f"Converted legacy {field} format to bilingual", file=sys.stderr)
        elif isinstance(field_data, dict):
            if 'ro' not in field_data or 'en' not in field_data:
                ro_data = field_data.get('ro', [])
                en_data = field_data.get('en', [])
                compliance_data[field] = {
                    'ro': ro_data if isinstance(ro_data, list) else [],
                    'en': en_data if isinstance(en_data, list) else []
                }
                print(f"Fixed incomplete bilingual structure for {field}", file=sys.stderr)
        else:
            compliance_data[field] = {'ro': [], 'en': []}
            print(f"Reset invalid {field} format to empty bilingual structure", file=sys.stderr)

    if 'overall_score' in compliance_data:
        try:
            compliance_data['overall_score'] = float(compliance_data['overall_score'])
        except (ValueError, TypeError):
            print("Fixed invalid overall_score format", file=sys.stderr)
            compliance_data['overall_score'] = 0.0

    return True

def clean_crew_output(text: str) -> str:
    """Clean crew output to extract only the JSON result."""
    if not text:
        return text

    # Remove ANSI escape codes
    import re
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)

    # CRITICAL FIX: If text contains 'line_items', NEVER truncate it
    # The line_items might be in a separate JSON object that would be lost
    has_line_items = '"line_items"' in text or "'line_items'" in text
    if has_line_items:
        print("🔍 clean_crew_output: Found 'line_items' in text - preserving FULL text to avoid losing line_items JSON object", file=sys.stderr)
        return text  # Return full text to preserve all JSON objects

    # Try to find JSON in crew completion section
    crew_completion_match = re.search(r'Final Output:\s*(\{[\s\S]*?\})', text)
    if crew_completion_match:
        print("🔍 Found crew completion JSON, extracting...", file=sys.stderr)
        return crew_completion_match.group(1)

    # Try to find JSON in the last part of the output
    lines = text.split('\n')
    for line in reversed(lines):
        line = line.strip()
        if line.startswith('{') and line.endswith('}'):
            try:
                json.loads(line)
                print("🔍 Found valid JSON in last lines", file=sys.stderr)
                return line
            except:
                continue

    # DEBUG: Log what we're returning if no JSON found
    if text and not (text.strip().startswith('{') or text.strip().startswith('[')):
        print(f"⚠️ clean_crew_output: Returning text that doesn't start with JSON (first 200 chars: {text[:200]})", file=sys.stderr)

    return text

def extract_json_from_text(text: str) -> dict:
    """Extract JSON from text with optimized parsing and compliance validation."""
    if not text:
        print("⚠️  WARNING: extract_json_from_text received empty text", file=sys.stderr)
        return {}

    import re

    # CRITICAL DEBUG: Log original text
    original_text_length = len(text)
    has_line_items_original = '"line_items"' in text or "'line_items'" in text
    print(f"🔍 [DEBUG] extract_json_from_text: Original text length={original_text_length}, has_line_items={has_line_items_original}", file=sys.stderr)
    if has_line_items_original:
        line_items_pos = text.find('"line_items"')
        if line_items_pos == -1:
            line_items_pos = text.find("'line_items'")
        print(f"🔍 [DEBUG] extract_json_from_text: 'line_items' found at position {line_items_pos} in original text", file=sys.stderr)
        print(f"🔍 [DEBUG] extract_json_from_text: Text around line_items (500 chars before, 1000 after): ...{text[max(0, line_items_pos-500):line_items_pos]}>>>LINE_ITEMS<<<{text[line_items_pos:min(len(text), line_items_pos+1000)]}...", file=sys.stderr)

    # Clean the crew output first
    cleaned_text = clean_crew_output(text)

    # CRITICAL DEBUG: Log cleaned text
    cleaned_text_length = len(cleaned_text)
    has_line_items_cleaned = '"line_items"' in cleaned_text or "'line_items'" in cleaned_text
    print(f"🔍 [DEBUG] extract_json_from_text: Cleaned text length={cleaned_text_length}, has_line_items={has_line_items_cleaned}", file=sys.stderr)
    if has_line_items_cleaned:
        line_items_pos_cleaned = cleaned_text.find('"line_items"')
        if line_items_pos_cleaned == -1:
            line_items_pos_cleaned = cleaned_text.find("'line_items'")
        print(f"🔍 [DEBUG] extract_json_from_text: 'line_items' found at position {line_items_pos_cleaned} in cleaned text", file=sys.stderr)
    elif has_line_items_original:
        print(f"🚨 [DEBUG] CRITICAL: 'line_items' was in original text but LOST after clean_crew_output!", file=sys.stderr)
        print(f"🚨 [DEBUG] Original text length: {original_text_length}, Cleaned text length: {cleaned_text_length}", file=sys.stderr)

    # Use the cleaned text for processing
    text = cleaned_text
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)
    text = text.strip()

    # CRITICAL DEBUG: Log final text after ANSI removal
    final_text_length = len(text)
    has_line_items_final = '"line_items"' in text or "'line_items'" in text
    print(f"🔍 [DEBUG] extract_json_from_text: Final text length={final_text_length}, has_line_items={has_line_items_final}", file=sys.stderr)
    if not has_line_items_final and has_line_items_original:
        print(f"🚨 [DEBUG] CRITICAL: 'line_items' was LOST during text processing!", file=sys.stderr)

    # CRITICAL FIX: Only try direct JSON parsing if text starts with JSON
    # This prevents "Expecting value: line 1 column 1" errors when text has non-JSON prefix
    text_starts_with_json = text.strip().startswith('{') or text.strip().startswith('[')

    if text_starts_with_json:
        # First try direct JSON parsing
        try:
            result = json.loads(text)

            # CRITICAL FIX: If this is an invoice and line_items is missing, don't return yet!
            # The text might contain multiple JSON objects, and we need to find the one with line_items
            is_invoice = result.get('document_type', '').lower() == 'invoice'
            has_line_items = 'line_items' in result and isinstance(result.get('line_items'), list) and len(result.get('line_items', [])) > 0

            if is_invoice and not has_line_items:
                # Don't return - continue to find_json_objects below
                pass
            else:
                # For non-invoices or invoices with line_items, return immediately
                if 'compliance_validation' in result:
                    if not validate_compliance_output(result):
                        print("WARNING: Invalid compliance validation format, attempting to fix...", file=sys.stderr)
                        validate_compliance_output(result)
                return result
        except json.JSONDecodeError as e:
            print(f"❌ Direct JSON parsing failed: {e}", file=sys.stderr)
            pass
    else:
        # Text doesn't start with JSON - skip direct parsing and go to pattern matching
        print(f"🔍 Text doesn't start with JSON (starts with: {text[:50] if text else 'empty'}...), using pattern matching", file=sys.stderr)

    def find_json_objects(text, max_objects=None):
        """Find all JSON objects in text. For invoices, don't limit to find all line_items."""
        results = []
        brace_count = 0
        start_idx = -1

        for i, char in enumerate(text):
            if char == '{':
                if brace_count == 0:
                    start_idx = i
                brace_count += 1
            elif char == '}':
                brace_count -= 1
                if brace_count == 0 and start_idx != -1:
                    try:
                        json_str = text[start_idx:i+1]
                        json_obj = json.loads(json_str)
                        results.append(json_obj)
                        # Only limit if max_objects is specified (for non-invoices)
                        if max_objects and len(results) >= max_objects:
                            break
                    except json.JSONDecodeError as e:
                        pass
                    start_idx = -1

        return results

    # Check if this might be an invoice by looking for invoice-related keywords
    is_potential_invoice = any(keyword in text.lower() for keyword in ['invoice', 'line_items', 'document_type'])

    # For potential invoices, find ALL JSON objects (no limit) to ensure we don't miss line_items
    # For other documents, limit to 10 for performance
    max_objects = None if is_potential_invoice else 10
    json_objects = find_json_objects(text, max_objects)

    print(f"🔍 [FIX] find_json_objects found {len(json_objects)} JSON objects", file=sys.stderr)
    if json_objects:
        # Log what we found
        for idx, obj in enumerate(json_objects[:5]):  # Log first 5 objects
            has_line_items = 'line_items' in obj and isinstance(obj.get('line_items'), list)
            line_items_count = len(obj.get('line_items', [])) if has_line_items else 0
            keys = list(obj.keys())[:10]  # First 10 keys
            print(f"🔍 [FIX] JSON object {idx}: keys={keys}, has_line_items={has_line_items}, line_items_count={line_items_count}", file=sys.stderr)

    if json_objects:
        # CRITICAL: Prioritize JSON objects that contain 'line_items'
        # This fixes the bug where line_items exist in the raw output but get lost
        objects_with_line_items = [obj for obj in json_objects if 'line_items' in obj and isinstance(obj.get('line_items'), list) and len(obj.get('line_items', [])) > 0]
        print(f"🔍 [FIX] Found {len(objects_with_line_items)} objects with non-empty line_items", file=sys.stderr)

        if objects_with_line_items:
            # If we found objects with line_items, use the one with the most line_items
            result = max(objects_with_line_items, key=lambda x: len(x.get('line_items', [])))

            # CRITICAL FIX: Try to merge with other objects to get complete data
            # Sometimes line_items are in one object and other fields in another
            if len(json_objects) > 1:
                # Find the object with the most other fields (excluding line_items)
                other_objects = [obj for obj in json_objects if obj != result]
                if other_objects:
                    # Merge with the largest other object to get complete data
                    largest_other = max(other_objects, key=lambda x: len([k for k in x.keys() if k != 'line_items']))
                    # Merge fields from largest_other into result, but preserve line_items from result
                    line_items_backup = result.get('line_items', [])
                    result.update(largest_other)
                    result['line_items'] = line_items_backup  # Preserve line_items from the object that had them
                    print(f"🔍 [FIX] Merged JSON objects to preserve line_items ({len(line_items_backup)} items)", file=sys.stderr)
        else:
            # Fall back to largest object
            json_objects.sort(key=lambda x: len(x.keys()), reverse=True)
            result = json_objects[0]

        if 'compliance_validation' in result:
            if not validate_compliance_output(result):
                print("WARNING: Invalid compliance validation format, attempting to fix...", file=sys.stderr)
                validate_compliance_output(result)
        return result

    # Try to extract JSON from code blocks (more flexible pattern)
    json_in_code = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
    if json_in_code:
        try:
            result = json.loads(json_in_code.group(1))
            print(f"Extracted JSON from code block. Keys: {list(result.keys())}", file=sys.stderr)

            # CRITICAL FIX: For invoices, check if line_items exist in the code block
            is_invoice = result.get('document_type', '').lower() == 'invoice'
            has_line_items = 'line_items' in result and isinstance(result.get('line_items'), list) and len(result.get('line_items', [])) > 0

            # If it's an invoice without line_items, don't return yet - continue searching
            if is_invoice and not has_line_items:
                print(f"⚠️ Code block JSON is invoice but missing line_items, continuing search...", file=sys.stderr)
            else:
                if 'compliance_validation' in result:
                    if not validate_compliance_output(result):
                        print("WARNING: Invalid compliance validation format, attempting to fix...", file=sys.stderr)
                        validate_compliance_output(result)
                return result
        except json.JSONDecodeError:
            pass

    # CRITICAL FIX: If we still haven't found line_items for an invoice, try a more aggressive search
    # Look for line_items array pattern in the raw text as a last resort
    if is_potential_invoice:
        # Search for the position of "line_items" in the text
        line_items_pattern = r'"line_items"\s*:\s*\['
        line_items_match = re.search(line_items_pattern, text, re.IGNORECASE)
        if line_items_match:
            print(f"🔍 [FIX] Found line_items pattern in raw text, attempting extraction...", file=sys.stderr)
            # Try to find the full JSON object containing this line_items
            # Look backwards and forwards from the match to find the enclosing braces
            match_start = line_items_match.start()
            match_end = line_items_match.end()

            # Find the start of the JSON object (go backwards to find opening brace)
            # CRITICAL FIX: Start with brace_count = 1 because we're inside the object that contains line_items
            # We need to find the opening brace that matches the closing brace we'll find
            start_idx = match_start
            brace_count = 1  # Start at 1 because we're already inside the object containing line_items
            found_start = False
            for i in range(match_start - 1, -1, -1):  # Start from match_start - 1 since we're already past the opening
                if text[i] == '}':
                    brace_count += 1
                elif text[i] == '{':
                    brace_count -= 1
                    if brace_count == 0:
                        start_idx = i
                        found_start = True
                        break
                # Safety: if we've gone too far back without finding the opening, give up
                if match_start - i > 100000:  # Limit search to 100KB backwards
                    print(f"⚠️ [FIX] Search for opening brace exceeded 100KB limit", file=sys.stderr)
                    break

            # Find the end of the JSON object (go forwards to find closing brace)
            # CRITICAL FIX: Start with brace_count = 1 because we're already inside the object containing line_items
            end_idx = match_end
            brace_count = 1  # Start at 1 because we're already inside the object containing line_items
            found_end = False
            for i in range(match_end, len(text)):
                if text[i] == '{':
                    brace_count += 1
                elif text[i] == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        end_idx = i + 1
                        found_end = True
                        break
                # Safety: if we've gone too far forward, give up
                if i - match_end > 1000000:  # Limit search to 1MB forward
                    print(f"⚠️ [FIX] Search for closing brace exceeded 1MB limit", file=sys.stderr)
                    break

            if found_start and found_end:
                try:
                    json_str = text[start_idx:end_idx]
                    print(f"🔍 [FIX] Extracted JSON string (length: {len(json_str)}, first 100 chars: {json_str[:100]}...)", file=sys.stderr)
                    result = json.loads(json_str)
                    if 'line_items' in result and isinstance(result.get('line_items'), list) and len(result.get('line_items', [])) > 0:
                        print(f"✅ [FIX] Successfully extracted invoice with {len(result.get('line_items', []))} line_items from raw text!", file=sys.stderr)
                    if 'compliance_validation' in result:
                        if not validate_compliance_output(result):
                            print("WARNING: Invalid compliance validation format, attempting to fix...", file=sys.stderr)
                            validate_compliance_output(result)
                    return result
                except json.JSONDecodeError as e:
                    print(f"⚠️ Failed to parse JSON from line_items pattern: {e}", file=sys.stderr)
                    print(f"🔍 [FIX] JSON string (first 500 chars): {json_str[:500]}", file=sys.stderr)
                    print(f"🔍 [FIX] JSON string (last 500 chars): {json_str[-500:]}", file=sys.stderr)
            else:
                print(f"⚠️ [FIX] Brace counting failed: found_start={found_start}, found_end={found_end}, match_start={match_start}, match_end={match_end}", file=sys.stderr)
                print(f"🔍 [FIX] Text around match (200 chars before, 200 after): ...{text[max(0, match_start-200):match_start]}>>>MATCH<<<{text[match_end:min(len(text), match_end+200)]}...", file=sys.stderr)

                # FALLBACK: Try to extract line_items array directly using regex if brace counting fails
                print(f"🔍 [FIX] Attempting fallback: direct line_items array extraction...", file=sys.stderr)
                try:
                    # Try to find the line_items array content directly
                    array_match = re.search(r'"line_items"\s*:\s*\[', text, re.IGNORECASE)
                    if array_match:
                        print(f"🔍 [FIX] Fallback: Found 'line_items': [ at position {array_match.start()}", file=sys.stderr)
                        array_start = array_match.end()
                        print(f"🔍 [FIX] Fallback: array_start={array_start}, text length={len(text)}", file=sys.stderr)
                        print(f"🔍 [FIX] Fallback: Text at array_start (first 200 chars): {repr(text[array_start:array_start+200])}", file=sys.stderr)
                        print(f"🔍 [FIX] Fallback: Text at array_start (raw, first 200 chars): {text[array_start:array_start+200]}", file=sys.stderr)
                        # Find the matching closing bracket
                        bracket_count = 1
                        array_end = array_start
                        search_limit = min(len(text), array_start + 500000)  # Limit to 500KB
                        print(f"🔍 [FIX] Fallback: Searching for closing bracket from position {array_start} to {search_limit}", file=sys.stderr)

                        for i in range(array_start, search_limit):
                            if text[i] == '[':
                                bracket_count += 1
                            elif text[i] == ']':
                                bracket_count -= 1
                                if bracket_count == 0:
                                    array_end = i
                                    print(f"🔍 [FIX] Fallback: Found closing bracket at position {array_end}", file=sys.stderr)
                                    break

                        if bracket_count == 0:
                            array_content = text[array_start:array_end]
                            print(f"🔍 [FIX] Fallback: Extracted array content (length: {len(array_content)} chars)", file=sys.stderr)
                            print(f"🔍 [FIX] Fallback: Array content preview (first 200 chars): {array_content[:200]}", file=sys.stderr)

                            # Try to parse as JSON array
                            try:
                                # Wrap in brackets to make it a valid JSON array
                                json_array_str = '[' + array_content + ']'
                                line_items_array = json.loads(json_array_str)
                                if line_items_array and len(line_items_array) > 0:
                                    print(f"✅ [FIX] Fallback: Directly extracted {len(line_items_array)} line_items from array!", file=sys.stderr)
                                    # Create a result object with the line_items
                                    result = {'line_items': line_items_array}
                                    # Try to get other fields from the first JSON object found
                                    if json_objects:
                                        other_obj = json_objects[0]
                                        for key, value in other_obj.items():
                                            if key != 'line_items':
                                                result[key] = value
                                        print(f"🔍 [FIX] Fallback: Merged with existing JSON object (keys: {list(result.keys())})", file=sys.stderr)
                                    return result
                                else:
                                    print(f"⚠️ [FIX] Fallback: Parsed array but it's empty", file=sys.stderr)
                            except json.JSONDecodeError as e:
                                print(f"⚠️ [FIX] Fallback: Failed to parse line_items array: {e}", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Array content (first 1000 chars): {array_content[:1000]}", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Array content (last 500 chars): {array_content[-500:] if len(array_content) > 500 else array_content}", file=sys.stderr)
                        else:
                            print(f"⚠️ [FIX] Fallback: Could not find matching closing bracket (bracket_count={bracket_count} after searching {search_limit - array_start} chars)", file=sys.stderr)
                            # AGGRESSIVE FIX: Try to extract up to the end of text or find the last ']' before a '}' or new object
                            print(f"🔍 [FIX] Fallback: Attempting aggressive extraction - searching for any closing bracket...", file=sys.stderr)

                            # Try to find the last ']' that might close the array, even if bracket_count isn't 0
                            # Look for ']' followed by ',' or '}' or end of text
                            last_bracket_pos = -1
                            search_end = min(len(text), array_start + 2000000)  # Search up to 2MB
                            print(f"🔍 [FIX] Fallback: Aggressive search from {array_start} to {search_end} (text length: {len(text)})", file=sys.stderr)

                            bracket_positions = []
                            # First pass: Find ALL ']' characters (less strict)
                            for i in range(array_start, search_end):
                                if text[i] == ']':
                                    bracket_positions.append(i)

                            # Second pass: Use bracket counting to find the matching closing bracket
                            if bracket_positions:
                                print(f"🔍 [FIX] Fallback: Found {len(bracket_positions)} ']' characters, using bracket counting to find match", file=sys.stderr)
                                for bracket_pos in bracket_positions:
                                    # Count brackets between array_start and this bracket
                                    bracket_count = 1  # Start at 1 because we're after the opening '['
                                    for j in range(array_start, bracket_pos):
                                        if text[j] == '[':
                                            bracket_count += 1
                                        elif text[j] == ']':
                                            bracket_count -= 1

                                    # Check if this bracket closes the array (bracket_count should be 1, meaning only the opening bracket remains)
                                    if bracket_count == 1:
                                        last_bracket_pos = bracket_pos
                                        print(f"🔍 [FIX] Fallback: Found matching closing bracket at position {last_bracket_pos} (bracket_count={bracket_count})", file=sys.stderr)
                                        break

                            print(f"🔍 [FIX] Fallback: Found {len(bracket_positions)} potential closing brackets", file=sys.stderr)

                            if last_bracket_pos > array_start:
                                # Try extracting up to this bracket
                                array_content = text[array_start:last_bracket_pos]
                                print(f"🔍 [FIX] Fallback: Aggressive extraction found potential end at position {last_bracket_pos} (extracted {len(array_content)} chars)", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Array content preview (first 300 chars): {array_content[:300]}", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Array content preview (last 300 chars): {array_content[-300:] if len(array_content) > 300 else array_content}", file=sys.stderr)

                                # Try to fix common JSON issues
                                # Remove trailing commas
                                original_content = array_content
                                array_content = re.sub(r',\s*$', '', array_content.strip())
                                # Try to balance brackets by removing unmatched opening brackets at the end
                                open_brackets = array_content.count('[')
                                close_brackets = array_content.count(']')
                                print(f"🔍 [FIX] Fallback: Bracket balance - open: {open_brackets}, close: {close_brackets}", file=sys.stderr)

                                if open_brackets > close_brackets:
                                    # Remove extra opening brackets from the end
                                    diff = open_brackets - close_brackets
                                    print(f"🔍 [FIX] Fallback: Removing {diff} extra opening brackets", file=sys.stderr)
                                    for _ in range(diff):
                                        last_open = array_content.rfind('[')
                                        if last_open > 0:
                                            array_content = array_content[:last_open] + array_content[last_open+1:]

                                try:
                                    json_array_str = '[' + array_content + ']'
                                    print(f"🔍 [FIX] Fallback: Attempting to parse JSON array (length: {len(json_array_str)} chars)", file=sys.stderr)
                                    line_items_array = json.loads(json_array_str)
                                    if line_items_array and len(line_items_array) > 0:
                                        print(f"✅ [FIX] Fallback (Aggressive): Extracted {len(line_items_array)} line_items!", file=sys.stderr)
                                        result = {'line_items': line_items_array}
                                        if json_objects:
                                            other_obj = json_objects[0]
                                            for key, value in other_obj.items():
                                                if key != 'line_items':
                                                    result[key] = value
                                        return result
                                    else:
                                        print(f"⚠️ [FIX] Fallback (Aggressive): Parsed but array is empty", file=sys.stderr)
                                except json.JSONDecodeError as e2:
                                    print(f"⚠️ [FIX] Fallback (Aggressive): Still failed to parse: {e2}", file=sys.stderr)
                                    print(f"🔍 [FIX] Fallback: Fixed array content (first 1000 chars): {array_content[:1000]}", file=sys.stderr)
                                    print(f"🔍 [FIX] Fallback: Fixed array content (last 500 chars): {array_content[-500:] if len(array_content) > 500 else array_content}", file=sys.stderr)
                            else:
                                print(f"⚠️ [FIX] Fallback (Aggressive): No potential closing brackets found in search range", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Text from array_start ({array_start}) to end (text length: {len(text)})", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Text from array_start to end (first 500 chars): {text[array_start:array_start+500] if array_start < len(text) else 'OUT OF BOUNDS'}", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Text from array_start to end (last 500 chars): {text[max(array_start, len(text)-500):] if array_start < len(text) else 'OUT OF BOUNDS'}", file=sys.stderr)
                                print(f"🔍 [FIX] Fallback: Checking if array_start is valid - array_start={array_start}, text_length={len(text)}, array_start < len(text)={array_start < len(text)}", file=sys.stderr)

                                # ULTIMATE FALLBACK: Use bracket counting to find the matching closing bracket
                                if array_start < len(text):
                                    print(f"🔍 [FIX] Fallback (Ultimate): Starting bracket counting from position {array_start}", file=sys.stderr)
                                    print(f"🔍 [FIX] Fallback (Ultimate): Text at array_start (first 100 chars): {repr(text[array_start:array_start+100])}", file=sys.stderr)

                                    # Use bracket counting to find the matching closing ']'
                                    bracket_count = 1  # Start at 1 because we're after the opening '['
                                    array_end_pos = -1
                                    search_end = len(text)  # Search to the very end of text

                                    print(f"🔍 [FIX] Fallback (Ultimate): Searching from {array_start} to {search_end} for matching ']' (text length: {len(text)})", file=sys.stderr)

                                    bracket_positions = []  # Track all ']' positions for debugging
                                    for i in range(array_start, search_end):
                                        if text[i] == '[':
                                            bracket_count += 1
                                        elif text[i] == ']':
                                            bracket_count -= 1
                                            bracket_positions.append((i, bracket_count))
                                            if bracket_count == 0:
                                                array_end_pos = i
                                                print(f"✅ [FIX] Fallback (Ultimate): Found matching closing ']' at position {array_end_pos} (bracket_count={bracket_count})", file=sys.stderr)
                                                break

                                    if array_end_pos == -1:
                                        print(f"⚠️ [FIX] Fallback (Ultimate): No matching ']' found. Final bracket_count={bracket_count}", file=sys.stderr)
                                        if bracket_positions:
                                            print(f"🔍 [FIX] Fallback (Ultimate): Found {len(bracket_positions)} ']' characters. Last 5 positions: {bracket_positions[-5:] if len(bracket_positions) >= 5 else bracket_positions}", file=sys.stderr)

                                    if array_end_pos > array_start:
                                        # Found the matching closing bracket
                                        array_content = text[array_start:array_end_pos]
                                        print(f"🔍 [FIX] Fallback (Ultimate): Extracted array content ({len(array_content)} chars)", file=sys.stderr)
                                        print(f"🔍 [FIX] Fallback (Ultimate): First 500 chars: {array_content[:500]}", file=sys.stderr)
                                        print(f"🔍 [FIX] Fallback (Ultimate): Last 500 chars: {array_content[-500:] if len(array_content) > 500 else array_content}", file=sys.stderr)

                                        # Clean up the array content
                                        array_content = array_content.strip()
                                        # Remove trailing commas
                                        array_content = re.sub(r',\s*$', '', array_content)

                                        # Try to parse as JSON array
                                        try:
                                            json_array_str = '[' + array_content + ']'
                                            print(f"🔍 [FIX] Fallback (Ultimate): Attempting to parse JSON array (length: {len(json_array_str)} chars)", file=sys.stderr)
                                            line_items_array = json.loads(json_array_str)
                                            if line_items_array and len(line_items_array) > 0:
                                                print(f"✅ [FIX] Fallback (Ultimate): Successfully extracted {len(line_items_array)} line_items!", file=sys.stderr)
                                                result = {'line_items': line_items_array}

                                                # Merge with existing JSON object if available
                                                if json_objects:
                                                    other_obj = json_objects[0]
                                                    for key, value in other_obj.items():
                                                        if key != 'line_items':
                                                            result[key] = value

                                                # Also extract other invoice fields from text
                                                patterns = [
                                                    (r'"document_type"\s*:\s*"([^"]+)"', 'document_type'),
                                                    (r'"direction"\s*:\s*"([^"]+)"', 'direction'),
                                                    (r'"document_number"\s*:\s*"([^"]+)"', 'document_number'),
                                                    (r'"document_date"\s*:\s*"([^"]+)"', 'document_date'),
                                                    (r'"vendor"\s*:\s*"([^"]+)"', 'vendor'),
                                                    (r'"vendor_ein"\s*:\s*"([^"]+)"', 'vendor_ein'),
                                                    (r'"buyer"\s*:\s*"([^"]+)"', 'buyer'),
                                                    (r'"buyer_ein"\s*:\s*"([^"]+)"', 'buyer_ein'),
                                                    (r'"total_amount"\s*:\s*([\d.]+)', 'total_amount'),
                                                    (r'"vat_amount"\s*:\s*([\d.]+)', 'vat_amount'),
                                                    (r'"currency"\s*:\s*"([^"]+)"', 'currency'),
                                                ]

                                                for pattern, key in patterns:
                                                    if key not in result:
                                                        match = re.search(pattern, text, re.IGNORECASE)
                                                        if match:
                                                            value = match.group(1)
                                                            if key in ['total_amount', 'vat_amount']:
                                                                try:
                                                                    result[key] = float(value)
                                                                except ValueError:
                                                                    result[key] = value
                                                            else:
                                                                # Remove spaces from document_number (e.g., "NEX 0009" -> "NEX0009")
                                                                if key == 'document_number':
                                                                    value = value.replace(' ', '')
                                                                result[key] = value

                                                print(f"🔍 [FIX] Fallback (Ultimate): Returning result with keys: {list(result.keys())}", file=sys.stderr)
                                                return result
                                            else:
                                                print(f"⚠️ [FIX] Fallback (Ultimate): Parsed but array is empty", file=sys.stderr)
                                        except json.JSONDecodeError as e3:
                                            print(f"⚠️ [FIX] Fallback (Ultimate): Failed to parse: {e3}", file=sys.stderr)
                                            print(f"🔍 [FIX] Fallback (Ultimate): Array content (first 1000 chars): {array_content[:1000]}", file=sys.stderr)
                                            print(f"🔍 [FIX] Fallback (Ultimate): Array content (last 500 chars): {array_content[-500:] if len(array_content) > 500 else array_content}", file=sys.stderr)
                                    else:
                                        # No matching closing bracket found - try to extract everything and find the last ']'
                                        print(f"⚠️ [FIX] Fallback (Ultimate): No matching ']' found (bracket_count={bracket_count}), trying alternative extraction", file=sys.stderr)

                                        # CRITICAL: Check if we should search in FULL text instead BEFORE extracting
                                        # Count "isNew": false in full text to see how many items we should have
                                        full_text_isnew = len(list(re.finditer(r'"isNew"\s*:\s*false', text)))
                                        print(f"🔍 [FIX] Fallback (Ultimate): FULL text has {full_text_isnew} 'isNew': false markers (expected: 29)", file=sys.stderr)

                                        # Extract everything from array_start to end
                                        array_content = text[array_start:]
                                        array_content_isnew = len(list(re.finditer(r'"isNew"\s*:\s*false', array_content)))
                                        print(f"🔍 [FIX] Fallback (Ultimate): array_content (from position {array_start}) has {array_content_isnew} 'isNew' markers", file=sys.stderr)
                                        print(f"🔍 [FIX] Fallback (Ultimate): Extracted from array_start to end ({len(array_content)} chars)", file=sys.stderr)
                                        print(f"🔍 [FIX] Fallback (Ultimate): First 500 chars: {repr(array_content[:500])}", file=sys.stderr)
                                        print(f"🔍 [FIX] Fallback (Ultimate): Last 500 chars: {repr(array_content[-500:] if len(array_content) > 500 else array_content)}", file=sys.stderr)

                                        # If full text has more markers, we're missing items - search from line_items in FULL text
                                        if full_text_isnew > array_content_isnew:
                                            print(f"⚠️ [FIX] Fallback (Ultimate): FULL text has MORE items ({full_text_isnew} vs {array_content_isnew})! Re-extracting from full text...", file=sys.stderr)
                                            # Find line_items in full text (might be at different position)
                                            full_line_items_match = re.search(r'"line_items"\s*:\s*\[', text)
                                            if full_line_items_match:
                                                full_array_start = full_line_items_match.end()
                                                array_content = text[full_array_start:]
                                                isnew_marker_count = len(re.findall(r'"isNew"\s*:\s*false', array_content))
                                                print(f"🔍 [FIX] Fallback (Ultimate): Re-extracted array_content from full text (length: {len(array_content)} chars, has {isnew_marker_count} markers)", file=sys.stderr)

                                        # Find ALL ']' characters and test each one with bracket counting
                                        all_brackets = []
                                        for i in range(len(array_content)):
                                            if array_content[i] == ']':
                                                all_brackets.append(i)

                                        print(f"🔍 [FIX] Fallback (Ultimate): Found {len(all_brackets)} ']' characters in extracted content", file=sys.stderr)

                                        # Test each ']' from the END backwards to find the one that closes the array
                                        last_valid_bracket = -1
                                        for bracket_pos in reversed(all_brackets):
                                            # Count brackets from start to this position
                                            test_count = 1  # Start at 1 (after opening '[')
                                            for j in range(0, bracket_pos + 1):
                                                if array_content[j] == '[':
                                                    test_count += 1
                                                elif array_content[j] == ']':
                                                    test_count -= 1
                                                    if test_count == 0 and j == bracket_pos:
                                                        # This bracket closes the array!
                                                        last_valid_bracket = bracket_pos
                                                        print(f"✅ [FIX] Fallback (Ultimate): Found valid closing ']' at position {last_valid_bracket} (tested {len(all_brackets) - all_brackets.index(bracket_pos)} brackets)", file=sys.stderr)
                                                        break
                                            if last_valid_bracket > 0:
                                                break

                                        if last_valid_bracket > 0:
                                            print(f"🔍 [FIX] Fallback (Ultimate): Using ']' at position {last_valid_bracket}", file=sys.stderr)
                                            array_content = array_content[:last_valid_bracket]
                                        else:
                                            # Fallback: find the last ']' in the content (should be the array closer)
                                            last_bracket = array_content.rfind(']')
                                            if last_bracket > 0:
                                                print(f"🔍 [FIX] Fallback (Ultimate): Using last ']' at position {last_bracket} (no valid bracket found via counting)", file=sys.stderr)
                                                array_content = array_content[:last_bracket]
                                            else:
                                                # No ']' found at all - the array might be malformed
                                                # PRIMARY METHOD: Use item boundary extraction to find all complete items
                                                print(f"⚠️ [FIX] Fallback (Ultimate): No ']' found in extracted content, using item boundary extraction method", file=sys.stderr)

                                                # CRITICAL: Check if the FULL text contains more items than array_content
                                                # Search for "isNew": false in the FULL text to count total items
                                                full_text_isnew_count = len(list(re.finditer(r'"isNew"\s*:\s*false', text)))
                                                array_content_isnew_count = len(list(re.finditer(r'"isNew"\s*:\s*false', array_content)))
                                                print(f"🔍 [FIX] Fallback (Ultimate): FULL text has {full_text_isnew_count} 'isNew': false markers, array_content has {array_content_isnew_count}", file=sys.stderr)

                                                # If full text has more markers, we need to search in the FULL text, not just array_content
                                                if full_text_isnew_count > array_content_isnew_count:
                                                    print(f"⚠️ [FIX] Fallback (Ultimate): FULL text has MORE items! Searching in full text instead of array_content", file=sys.stderr)
                                                    # Find where line_items array starts in full text
                                                    line_items_match = re.search(r'"line_items"\s*:\s*\[', text)
                                                    if line_items_match:
                                                        full_array_start = line_items_match.end()
                                                        # Extract from full text, not just array_content
                                                        full_array_content = text[full_array_start:]
                                                        print(f"🔍 [FIX] Fallback (Ultimate): Using full text array_content (length: {len(full_array_content)} chars)", file=sys.stderr)
                                                        array_content = full_array_content

                                                # Find all item boundaries using multiple patterns to catch all variations
                                                # Pattern 1: } followed by comma, newline, whitespace, and {
                                                boundaries1 = list(re.finditer(r'\}\s*,\s*\n\s*\{', array_content))
                                                # Pattern 2: } followed by newline, whitespace, and { (no comma)
                                                boundaries2 = list(re.finditer(r'\}\s*\n\s*\{', array_content))
                                                # Combine and deduplicate (keep only unique positions)
                                                all_boundary_positions = set()
                                                for m in boundaries1:
                                                    all_boundary_positions.add(m.start())
                                                for m in boundaries2:
                                                    all_boundary_positions.add(m.start())
                                                # Sort positions
                                                item_boundaries = sorted(all_boundary_positions)
                                                print(f"🔍 [FIX] Fallback (Ultimate): Found {len(item_boundaries)} item boundaries using pattern extraction", file=sys.stderr)

                                                # Also check for item names that should be present (items 24-29)
                                                expected_item_names = [
                                                    "Semințe de dovleac 50g",
                                                    "Miez de floarea soarelui 30g",
                                                    "Trufe pecan 90g",
                                                    "Arahide cu ciocolată 90g",
                                                    "Stafide cu ciocolată 90g",
                                                    "Cappuccino crisp 80g"
                                                ]
                                                found_expected_items = []
                                                for item_name in expected_item_names:
                                                    # Search for the item name in the text
                                                    if item_name in text or item_name.replace('ă', 'a') in text:
                                                        found_expected_items.append(item_name)
                                                print(f"🔍 [FIX] Fallback (Ultimate): Found {len(found_expected_items)}/6 expected items (24-29) in text: {found_expected_items}", file=sys.stderr)

                                                if item_boundaries:
                                                    # Extract all complete items
                                                    items = []
                                                    start_pos = 0

                                                    # Process each boundary
                                                    for i, boundary_pos in enumerate(item_boundaries):
                                                        # Extract item from start_pos to the closing brace before this boundary
                                                        item_end = boundary_pos + 1  # Include the '}'
                                                        item_str = array_content[start_pos:item_end].strip().rstrip(',')

                                                        # Skip if empty
                                                        if not item_str or item_str == '{' or item_str == '}':
                                                            # Find the actual start of the next item
                                                            next_start = array_content.find('{', boundary_pos + 1)
                                                            if next_start > 0:
                                                                start_pos = next_start
                                                            continue

                                                        try:
                                                            item_obj = json.loads(item_str)
                                                            items.append(item_obj)
                                                            print(f"🔍 [FIX] Fallback (Ultimate): Extracted item {len(items)} (length: {len(item_str)} chars, name: {item_obj.get('name', 'N/A')[:50]})", file=sys.stderr)
                                                        except json.JSONDecodeError as e:
                                                            print(f"⚠️ [FIX] Fallback (Ultimate): Failed to parse item at boundary {i+1}: {e}", file=sys.stderr)
                                                            print(f"🔍 [FIX] Fallback (Ultimate): Item string (first 200 chars): {item_str[:200]}", file=sys.stderr)

                                                        # Find the start of the next item (the '{' after this boundary)
                                                        next_start = array_content.find('{', boundary_pos + 1)
                                                        if next_start > 0:
                                                            start_pos = next_start
                                                        else:
                                                            # No more items found
                                                            break

                                                    # Try to get the last item (everything after the last boundary)
                                                    if start_pos < len(array_content):
                                                        last_item_str = array_content[start_pos:].strip().rstrip(',').rstrip(']')
                                                        # Remove any trailing incomplete content
                                                        # Find the last complete object by counting braces
                                                        brace_count = 0
                                                        last_complete_pos = -1
                                                        for i, char in enumerate(last_item_str):
                                                            if char == '{':
                                                                brace_count += 1
                                                            elif char == '}':
                                                                brace_count -= 1
                                                                if brace_count == 0:
                                                                    last_complete_pos = i + 1
                                                        if last_complete_pos > 0:
                                                            last_item_str = last_item_str[:last_complete_pos]

                                                        # Try to complete it if it's missing closing braces
                                                        open_braces = last_item_str.count('{')
                                                        close_braces = last_item_str.count('}')
                                                        if open_braces > close_braces:
                                                            last_item_str += '}' * (open_braces - close_braces)

                                                        if last_item_str and len(last_item_str) > 10:  # Minimum length check
                                                            try:
                                                                last_item = json.loads(last_item_str)
                                                                items.append(last_item)
                                                                print(f"🔍 [FIX] Fallback (Ultimate): Extracted last item {len(items)} (length: {len(last_item_str)} chars, name: {last_item.get('name', 'N/A')[:50]})", file=sys.stderr)
                                                            except json.JSONDecodeError as e:
                                                                print(f"⚠️ [FIX] Fallback (Ultimate): Failed to parse last item: {e}", file=sys.stderr)
                                                                print(f"🔍 [FIX] Fallback (Ultimate): Last item string (first 200 chars): {last_item_str[:200]}", file=sys.stderr)
                                                                print(f"🔍 [FIX] Fallback (Ultimate): Last item string (last 200 chars): {last_item_str[-200:] if len(last_item_str) > 200 else last_item_str}", file=sys.stderr)

                                                    # If we didn't get enough items (should have 29, but got less), try alternative method
                                                    if len(items) < 25:  # If we got less than 25, something is wrong
                                                        print(f"⚠️ [FIX] Fallback (Ultimate): Only extracted {len(items)} items, expected ~29. Trying alternative extraction using 'isNew' markers...", file=sys.stderr)

                                                        # Alternative method: Find all "isNew": false markers in FULL TEXT and extract complete objects
                                                        # Use FULL text, not just array_content, to catch all items
                                                        isnew_markers_full = list(re.finditer(r'"isNew"\s*:\s*false', text))
                                                        isnew_markers_array = list(re.finditer(r'"isNew"\s*:\s*false', array_content))
                                                        print(f"🔍 [FIX] Fallback (Ultimate): Found {len(isnew_markers_full)} 'isNew': false markers in FULL text, {len(isnew_markers_array)} in array_content", file=sys.stderr)

                                                        # Use whichever has more markers
                                                        search_text = text if len(isnew_markers_full) > len(isnew_markers_array) else array_content
                                                        isnew_markers = isnew_markers_full if len(isnew_markers_full) > len(isnew_markers_array) else isnew_markers_array
                                                        search_text_name = "FULL text" if len(isnew_markers_full) > len(isnew_markers_array) else "array_content"
                                                        print(f"🔍 [FIX] Fallback (Ultimate): Using {search_text_name} with {len(isnew_markers)} markers for extraction", file=sys.stderr)

                                                        if len(isnew_markers) > len(items):
                                                            # Extract items using isNew markers
                                                            alt_items = []
                                                            for i, marker in enumerate(isnew_markers):
                                                                # Find the opening brace of this item by going backwards
                                                                marker_pos = marker.start()
                                                                brace_count = 0
                                                                item_start = -1

                                                                # Go backwards to find the opening '{' of this item
                                                                for j in range(marker_pos, -1, -1):
                                                                    if search_text[j] == '}':
                                                                        brace_count += 1
                                                                    elif search_text[j] == '{':
                                                                        brace_count -= 1
                                                                        if brace_count == 0:
                                                                            item_start = j
                                                                            break

                                                                if item_start >= 0:
                                                                    # Find the closing '}' of this item by going forwards from marker
                                                                    brace_count = 1  # We're inside the item object
                                                                    item_end = -1
                                                                    for j in range(marker_pos, len(search_text)):
                                                                        if search_text[j] == '{':
                                                                            brace_count += 1
                                                                        elif search_text[j] == '}':
                                                                            brace_count -= 1
                                                                            if brace_count == 0:
                                                                                item_end = j + 1
                                                                                break

                                                                    if item_end > item_start:
                                                                        item_str = search_text[item_start:item_end].strip()
                                                                        try:
                                                                            item_obj = json.loads(item_str)
                                                                            alt_items.append(item_obj)
                                                                            if len(alt_items) <= 5 or len(alt_items) % 5 == 0:  # Log every 5th item to avoid spam
                                                                                print(f"🔍 [FIX] Fallback (Ultimate): Extracted item {len(alt_items)} via isNew method (name: {item_obj.get('name', 'N/A')[:50]})", file=sys.stderr)
                                                                        except json.JSONDecodeError as e:
                                                                            if i < 5:  # Only log first few errors
                                                                                print(f"⚠️ [FIX] Fallback (Ultimate): Failed to parse item {i+1} via isNew: {e}", file=sys.stderr)

                                                            if len(alt_items) > len(items):
                                                                print(f"✅ [FIX] Fallback (Ultimate): Alternative method extracted {len(alt_items)} items (better than {len(items)})", file=sys.stderr)
                                                                items = alt_items
                                                            else:
                                                                print(f"⚠️ [FIX] Fallback (Ultimate): Alternative method only extracted {len(alt_items)} items (same or worse than {len(items)})", file=sys.stderr)

                                                    if items:
                                                        print(f"✅ [FIX] Fallback (Ultimate): Successfully extracted {len(items)} line_items using item boundary method!", file=sys.stderr)
                                                        result = {'line_items': items}

                                                        # Merge with existing JSON object and extract other fields
                                                        if json_objects:
                                                            other_obj = json_objects[0]
                                                            for key, value in other_obj.items():
                                                                if key != 'line_items':
                                                                    result[key] = value

                                                        # Extract other invoice fields
                                                        patterns = [
                                                            (r'"document_type"\s*:\s*"([^"]+)"', 'document_type'),
                                                            (r'"direction"\s*:\s*"([^"]+)"', 'direction'),
                                                            (r'"document_number"\s*:\s*"([^"]+)"', 'document_number'),
                                                            (r'"document_date"\s*:\s*"([^"]+)"', 'document_date'),
                                                            (r'"vendor"\s*:\s*"([^"]+)"', 'vendor'),
                                                            (r'"vendor_ein"\s*:\s*"([^"]+)"', 'vendor_ein'),
                                                            (r'"buyer"\s*:\s*"([^"]+)"', 'buyer'),
                                                            (r'"buyer_ein"\s*:\s*"([^"]+)"', 'buyer_ein'),
                                                            (r'"total_amount"\s*:\s*([\d.]+)', 'total_amount'),
                                                            (r'"vat_amount"\s*:\s*([\d.]+)', 'vat_amount'),
                                                            (r'"currency"\s*:\s*"([^"]+)"', 'currency'),
                                                        ]

                                                        for pattern, key in patterns:
                                                            if key not in result:
                                                                match = re.search(pattern, text, re.IGNORECASE)
                                                                if match:
                                                                    value = match.group(1)
                                                                    if key in ['total_amount', 'vat_amount']:
                                                                        try:
                                                                            result[key] = float(value)
                                                                        except ValueError:
                                                                            result[key] = value
                                                                    else:
                                                                        if key == 'document_number':
                                                                            value = value.replace(' ', '')
                                                                        result[key] = value

                                                        print(f"🔍 [FIX] Fallback (Ultimate): Returning result with keys: {list(result.keys())}", file=sys.stderr)
                                                        return result

                                                # FALLBACK: Use brace counting to find the '}' that closes the parent object containing the array
                                                # We need to find the '}' that comes after all array items are closed
                                                # Count braces from array_start to find where the parent object ends
                                                brace_count = 0  # We're inside the array, so we need to count braces in array items
                                                last_valid_brace = -1

                                                # Look for '}' characters and use brace counting to find the one that closes after the array
                                                for i in range(len(array_content)):
                                                    if array_content[i] == '{':
                                                        brace_count += 1
                                                    elif array_content[i] == '}':
                                                        brace_count -= 1
                                                        # If brace_count becomes negative, we've closed more than we opened
                                                        # This means we've closed the parent object - but we want the one BEFORE that
                                                        if brace_count < 0:
                                                            # Go back to find the last '}' where brace_count was 0
                                                            break
                                                        # Track the last '}' where brace_count is 0 (all nested objects closed)
                                                        if brace_count == 0:
                                                            last_valid_brace = i

                                                if last_valid_brace > 0:
                                                    # Check what comes after this '}'
                                                    after_brace = array_content[last_valid_brace+1:last_valid_brace+20].strip()
                                                    print(f"🔍 [FIX] Fallback (Ultimate): Found potential end at brace position {last_valid_brace}, text after: {repr(after_brace)}", file=sys.stderr)

                                                    # If after_brace starts with ']' or is empty/whitespace, this might be the end
                                                    if after_brace.startswith(']') or not after_brace:
                                                        # This looks like the end - extract up to here and add ']'
                                                        array_content = array_content[:last_valid_brace+1].rstrip().rstrip(',')
                                                        # Count brackets and add missing ']'
                                                        open_brackets = array_content.count('[')
                                                        close_brackets = array_content.count(']')
                                                        if open_brackets > close_brackets:
                                                            diff = open_brackets - close_brackets
                                                            print(f"🔍 [FIX] Fallback (Ultimate): Adding {diff} closing brackets", file=sys.stderr)
                                                            array_content = array_content + (']' * diff)
                                                    else:
                                                        # There might be more items - find ALL complete objects
                                                        # Strategy: Find the last '}' that is NOT followed by ',' and '{' (meaning more items)
                                                        # Iterate backwards through all '}' to find the true end
                                                        all_braces = []
                                                        for i in range(len(array_content)):
                                                            if array_content[i] == '}':
                                                                all_braces.append(i)

                                                        print(f"🔍 [FIX] Fallback (Ultimate): Found {len(all_braces)} '}}' characters, searching for true end...", file=sys.stderr)

                                                        # Go backwards through braces to find the last one that's NOT followed by another item
                                                        true_end_brace = -1
                                                        for brace_pos in reversed(all_braces):
                                                            # Check what comes after this brace (get more characters to see if there's a '{' after comma)
                                                            after_this_brace_raw = array_content[brace_pos+1:brace_pos+200]
                                                            after_this_brace = after_this_brace_raw.strip()
                                                            print(f"🔍 [FIX] Fallback (Ultimate): Checking brace at {brace_pos}, after: {repr(after_this_brace_raw[:50])}", file=sys.stderr)

                                                            # If it's followed by ']' or end of text, this is the end
                                                            if after_this_brace.startswith(']') or not after_this_brace:
                                                                true_end_brace = brace_pos
                                                                print(f"✅ [FIX] Fallback (Ultimate): Found true end at brace position {true_end_brace}", file=sys.stderr)
                                                                break

                                                            # Check if there's a pattern like ', ... {' (comma followed by optional whitespace and then '{')
                                                            # This indicates more items
                                                            has_more_items = re.search(r',\s*\{', after_this_brace_raw)

                                                            if has_more_items:
                                                                # There are more items - continue searching
                                                                print(f"🔍 [FIX] Fallback (Ultimate): Brace at {brace_pos} is followed by more items (pattern: ', ... {{'), continuing search...", file=sys.stderr)
                                                                continue
                                                            elif after_this_brace.startswith(','):
                                                                # It's followed by ',' but NOT by '{' - this might be the end
                                                                true_end_brace = brace_pos
                                                                print(f"✅ [FIX] Fallback (Ultimate): Found true end at brace position {true_end_brace} (comma but no more items)", file=sys.stderr)
                                                                break
                                                            # Otherwise, continue searching

                                                        if true_end_brace > 0:
                                                            # Extract up to the true end, but make sure we have a complete last item
                                                            # Find the last complete line item by looking for patterns like "},\n    {" or "}\n    {"
                                                            # which indicate item boundaries
                                                            extracted = array_content[:true_end_brace+1]

                                                            # Check if the last item is complete by looking for common line item endings
                                                            # Line items typically end with "isNew": false\n    }
                                                            if not extracted.rstrip().endswith('"isNew": false') and '"isNew": false' in extracted:
                                                                # Find the last occurrence of "isNew": false and include everything up to the closing brace after it
                                                                last_isnew = extracted.rfind('"isNew": false')
                                                                if last_isnew > 0:
                                                                    # Find the closing brace after "isNew": false
                                                                    after_isnew = extracted[last_isnew:]
                                                                    # Look for the closing brace that closes this line item object
                                                                    brace_count = 0
                                                                    found_closing = False
                                                                    for i, char in enumerate(after_isnew):
                                                                        if char == '{':
                                                                            brace_count += 1
                                                                        elif char == '}':
                                                                            brace_count -= 1
                                                                            if brace_count == 0:
                                                                                # This closes the line item object
                                                                                true_end_brace = last_isnew + i
                                                                                extracted = array_content[:true_end_brace+1]
                                                                                found_closing = True
                                                                                print(f"🔍 [FIX] Fallback (Ultimate): Adjusted end to include complete last item (new position: {true_end_brace})", file=sys.stderr)
                                                                                break

                                                            array_content = extracted.rstrip().rstrip(',')
                                                            # Count brackets and add missing ']'
                                                            open_brackets = array_content.count('[')
                                                            close_brackets = array_content.count(']')
                                                            if open_brackets > close_brackets:
                                                                diff = open_brackets - close_brackets
                                                                print(f"🔍 [FIX] Fallback (Ultimate): Adding {diff} closing brackets", file=sys.stderr)
                                                                array_content = array_content + (']' * diff)
                                                        else:
                                                            # Fallback: use the last brace and hope for the best
                                                            last_brace = array_content.rfind('}')
                                                            if last_brace > 0:
                                                                print(f"⚠️ [FIX] Fallback (Ultimate): Could not find true end, using last brace at {last_brace}", file=sys.stderr)
                                                                array_content = array_content[:last_brace+1].rstrip().rstrip(',')
                                                                open_brackets = array_content.count('[')
                                                                close_brackets = array_content.count(']')
                                                                if open_brackets > close_brackets:
                                                                    diff = open_brackets - close_brackets
                                                                    print(f"🔍 [FIX] Fallback (Ultimate): Adding {diff} closing brackets", file=sys.stderr)
                                                                    array_content = array_content + (']' * diff)

                                        # Clean up
                                        array_content = array_content.strip().rstrip(',')

                                        # Try to parse
                                        try:
                                            json_array_str = '[' + array_content + ']'
                                            print(f"🔍 [FIX] Fallback (Ultimate): Attempting to parse malformed JSON array (length: {len(json_array_str)} chars)", file=sys.stderr)
                                            line_items_array = json.loads(json_array_str)
                                            if line_items_array and len(line_items_array) > 0:
                                                print(f"✅ [FIX] Fallback (Ultimate): Successfully extracted {len(line_items_array)} line_items from malformed JSON!", file=sys.stderr)
                                                result = {'line_items': line_items_array}

                                                # Merge with existing JSON object if available
                                                if json_objects:
                                                    other_obj = json_objects[0]
                                                    for key, value in other_obj.items():
                                                        if key != 'line_items':
                                                            result[key] = value

                                                # Also extract other invoice fields from text using pattern matching
                                                patterns = [
                                                    (r'"document_type"\s*:\s*"([^"]+)"', 'document_type'),
                                                    (r'"direction"\s*:\s*"([^"]+)"', 'direction'),
                                                    (r'"document_number"\s*:\s*"([^"]+)"', 'document_number'),
                                                    (r'"document_date"\s*:\s*"([^"]+)"', 'document_date'),
                                                    (r'"vendor"\s*:\s*"([^"]+)"', 'vendor'),
                                                    (r'"vendor_ein"\s*:\s*"([^"]+)"', 'vendor_ein'),
                                                    (r'"buyer"\s*:\s*"([^"]+)"', 'buyer'),
                                                    (r'"buyer_ein"\s*:\s*"([^"]+)"', 'buyer_ein'),
                                                    (r'"total_amount"\s*:\s*([\d.]+)', 'total_amount'),
                                                    (r'"vat_amount"\s*:\s*([\d.]+)', 'vat_amount'),
                                                    (r'"currency"\s*:\s*"([^"]+)"', 'currency'),
                                                ]

                                                for pattern, key in patterns:
                                                    if key not in result:  # Don't overwrite existing values
                                                        match = re.search(pattern, text, re.IGNORECASE)
                                                        if match:
                                                            value = match.group(1)
                                                            if key in ['total_amount', 'vat_amount']:
                                                                try:
                                                                    result[key] = float(value)
                                                                except ValueError:
                                                                    result[key] = value
                                                            else:
                                                                # Remove spaces from document_number (e.g., "NEX 0009" -> "NEX0009")
                                                                if key == 'document_number':
                                                                    value = value.replace(' ', '')
                                                                result[key] = value

                                                print(f"🔍 [FIX] Fallback (Ultimate): Returning result with keys: {list(result.keys())}", file=sys.stderr)
                                                return result
                                        except json.JSONDecodeError as e4:
                                            print(f"⚠️ [FIX] Fallback (Ultimate): Final parse attempt failed: {e4}", file=sys.stderr)
                                            print(f"🔍 [FIX] Fallback (Ultimate): Final array content (first 1000 chars): {repr(array_content[:1000])}", file=sys.stderr)
                                            print(f"🔍 [FIX] Fallback (Ultimate): Final array content (last 500 chars): {repr(array_content[-500:] if len(array_content) > 500 else array_content)}", file=sys.stderr)

                                            # Last resort: try to extract all complete items by finding item boundaries
                                            # Line items are typically separated by patterns like "},\n    {" or "}\n    {"
                                            print(f"🔍 [FIX] Fallback (Ultimate): Attempting to extract complete items by finding item boundaries...", file=sys.stderr)

                                            # Find all item boundaries (pattern: } followed by optional comma, newline, whitespace, and {)
                                            item_boundaries = list(re.finditer(r'\}\s*,?\s*\n\s*\{', array_content))
                                            print(f"🔍 [FIX] Fallback (Ultimate): Found {len(item_boundaries)} item boundaries", file=sys.stderr)

                                            if item_boundaries:
                                                # Extract all complete items
                                                items = []
                                                start_pos = 0
                                                for i, boundary in enumerate(item_boundaries):
                                                    # Extract item from start_pos to the end of this boundary's closing brace
                                                    item_end = boundary.start() + 1  # Include the '}'
                                                    item_str = array_content[start_pos:item_end].strip().rstrip(',')
                                                    if item_str:
                                                        try:
                                                            item_obj = json.loads(item_str)
                                                            items.append(item_obj)
                                                        except:
                                                            pass
                                                    start_pos = boundary.end() - 1  # Start of next item (the '{')

                                                # Try to get the last item (everything after the last boundary)
                                                if start_pos < len(array_content):
                                                    last_item_str = array_content[start_pos:].strip().rstrip(',').rstrip(']')
                                                    # Try to complete it if it's missing closing braces
                                                    open_braces = last_item_str.count('{')
                                                    close_braces = last_item_str.count('}')
                                                    if open_braces > close_braces:
                                                        last_item_str += '}' * (open_braces - close_braces)
                                                    try:
                                                        last_item = json.loads(last_item_str)
                                                        items.append(last_item)
                                                    except:
                                                        pass

                                                if items:
                                                    print(f"✅ [FIX] Fallback (Ultimate): Extracted {len(items)} complete line_items using item boundary method!", file=sys.stderr)
                                                    result = {'line_items': items}

                                                    # Merge with existing JSON object and extract other fields (same as above)
                                                    if json_objects:
                                                        other_obj = json_objects[0]
                                                        for key, value in other_obj.items():
                                                            if key != 'line_items':
                                                                result[key] = value

                                                    # Extract other invoice fields
                                                    patterns = [
                                                        (r'"document_type"\s*:\s*"([^"]+)"', 'document_type'),
                                                        (r'"direction"\s*:\s*"([^"]+)"', 'direction'),
                                                        (r'"document_number"\s*:\s*"([^"]+)"', 'document_number'),
                                                        (r'"document_date"\s*:\s*"([^"]+)"', 'document_date'),
                                                        (r'"vendor"\s*:\s*"([^"]+)"', 'vendor'),
                                                        (r'"vendor_ein"\s*:\s*"([^"]+)"', 'vendor_ein'),
                                                        (r'"buyer"\s*:\s*"([^"]+)"', 'buyer'),
                                                        (r'"buyer_ein"\s*:\s*"([^"]+)"', 'buyer_ein'),
                                                        (r'"total_amount"\s*:\s*([\d.]+)', 'total_amount'),
                                                        (r'"vat_amount"\s*:\s*([\d.]+)', 'vat_amount'),
                                                        (r'"currency"\s*:\s*"([^"]+)"', 'currency'),
                                                    ]

                                                    for pattern, key in patterns:
                                                        if key not in result:
                                                            match = re.search(pattern, text, re.IGNORECASE)
                                                            if match:
                                                                value = match.group(1)
                                                                if key in ['total_amount', 'vat_amount']:
                                                                    try:
                                                                        result[key] = float(value)
                                                                    except ValueError:
                                                                        result[key] = value
                                                                else:
                                                                    if key == 'document_number':
                                                                        value = value.replace(' ', '')
                                                                    result[key] = value

                                                    print(f"🔍 [FIX] Fallback (Ultimate): Returning result with keys: {list(result.keys())}", file=sys.stderr)
                                                    return result

                                            # Last resort: try to find ANY ']' in the original text
                                            any_bracket_pos = text.find(']', array_start)
                                            print(f"🔍 [FIX] Fallback (Ultimate): First ']' after array_start in original text: {any_bracket_pos}", file=sys.stderr)
                                            if any_bracket_pos > array_start:
                                                print(f"🔍 [FIX] Fallback (Ultimate): Text around ']' (200 chars before, 200 after): ...{text[max(0, any_bracket_pos-200):any_bracket_pos]}>>>]<<<{text[any_bracket_pos+1:min(len(text), any_bracket_pos+201)]}...", file=sys.stderr)
                    else:
                        print(f"⚠️ [FIX] Fallback: Could not find 'line_items': [ pattern in text", file=sys.stderr)
                except Exception as fallback_error:
                    print(f"⚠️ [FIX] Fallback extraction failed with exception: {fallback_error}", file=sys.stderr)
                    # Use module-level traceback import (don't re-import locally to avoid shadowing)
                    import traceback as tb_fallback
                    print(f"🔍 [FIX] Fallback traceback: {tb_fallback.format_exc()}", file=sys.stderr)

    if any(keyword in text.lower() for keyword in ["document_type", "vendor", "buyer", "company", "compliance_validation", "document_number", "document_date", "total_amount"]):
        result = {}
        patterns = [
            (r'"document_type"\s*:\s*"([^"]+)"', 'document_type'),
            (r'"direction"\s*:\s*"([^"]+)"', 'direction'),
            (r'"document_number"\s*:\s*"([^"]+)"', 'document_number'),
            (r'"document_date"\s*:\s*"([^"]+)"', 'document_date'),
            (r'"vendor"\s*:\s*"([^"]+)"', 'vendor'),
            (r'"vendor_ein"\s*:\s*"([^"]+)"', 'vendor_ein'),
            (r'"buyer"\s*:\s*"([^"]+)"', 'buyer'),
            (r'"buyer_ein"\s*:\s*"([^"]+)"', 'buyer_ein'),
            (r'"total_amount"\s*:\s*([\d.]+)', 'total_amount'),
            (r'"vat_amount"\s*:\s*([\d.]+)', 'vat_amount'),
            (r'"currency"\s*:\s*"([^"]+)"', 'currency'),
            (r'"company_name"\s*:\s*"([^"]+)"', 'company_name'),
            (r'"company_ein"\s*:\s*"([^"]+)"', 'company_ein'),
        ]

        for pattern, key in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                value = match.group(1)
                if key in ['total_amount', 'vat_amount']:
                    try:
                        result[key] = float(value)
                    except ValueError:
                        result[key] = value
                else:
                    # Remove spaces from document_number (e.g., "NEX 0009" -> "NEX0009")
                    if key == 'document_number':
                        value = value.replace(' ', '')
                    result[key] = value

        # CRITICAL FIX: Try to extract line_items if they exist in the text
        # Check if line_items pattern exists in text (simple check to avoid expensive regex)
        if '"line_items"' in text or "'line_items'" in text:
            print(f"🔍 [FIX] Detected line_items in text, attempting extraction...", file=sys.stderr)
            # Try to find JSON object containing line_items using the same method as above
            line_items_pattern = r'"line_items"\s*:\s*\['
            line_items_match = re.search(line_items_pattern, text, re.IGNORECASE)
            if line_items_match:
                match_start = line_items_match.start()
                match_end = match_start + 100  # Start search from line_items position

                # Find the start of the JSON object (go backwards)
                # CRITICAL FIX: Start with brace_count = 1 because we're inside the object that contains line_items
                start_idx = match_start
                brace_count = 1  # Start at 1 because we're already inside the object containing line_items
                found_start = False
                search_limit = max(0, match_start - 100000)  # Increase limit to 100KB back
                for i in range(match_start - 1, search_limit, -1):  # Start from match_start - 1
                    if text[i] == '}':
                        brace_count += 1
                    elif text[i] == '{':
                        brace_count -= 1
                        if brace_count == 0:
                            start_idx = i
                            found_start = True
                            break
                    # Safety: if we've gone too far back, give up
                    if match_start - i > 100000:
                        print(f"⚠️ [FIX] Pattern search: Search for opening brace exceeded 100KB limit", file=sys.stderr)
                        break

                # Find the end of the JSON object (go forwards)
                # CRITICAL FIX: Start with brace_count = 1 because we're already inside the object containing line_items
                end_idx = match_end
                brace_count = 1  # Start at 1 because we're already inside the object containing line_items
                found_end = False
                search_limit = min(len(text), match_end + 1000000)  # Increase limit to 1MB forward
                for i in range(match_end, search_limit):
                    if text[i] == '{':
                        brace_count += 1
                    elif text[i] == '}':
                        brace_count -= 1
                        if brace_count == 0:
                            end_idx = i + 1
                            found_end = True
                            break
                    # Safety: if we've gone too far forward, give up
                    if i - match_end > 1000000:
                        print(f"⚠️ [FIX] Pattern search: Search for closing brace exceeded 1MB limit", file=sys.stderr)
                        break

                if found_start and found_end:
                    try:
                        json_str = text[start_idx:end_idx]
                        print(f"🔍 [FIX] Pattern search extracted JSON (length: {len(json_str)}, first 100 chars: {json_str[:100]}...)", file=sys.stderr)
                        line_items_obj = json.loads(json_str)
                        if 'line_items' in line_items_obj and isinstance(line_items_obj.get('line_items'), list):
                            line_items_count = len(line_items_obj.get('line_items', []))
                            result['line_items'] = line_items_obj.get('line_items', [])
                            # Also merge other fields from the extracted object
                            for key, value in line_items_obj.items():
                                if key != 'line_items' and key not in result:
                                    result[key] = value
                            print(f"✅ [FIX] Extracted {line_items_count} line_items using pattern search!", file=sys.stderr)
                        else:
                            print(f"⚠️ [FIX] Extracted JSON object but line_items is missing or empty (keys: {list(line_items_obj.keys())[:10]})", file=sys.stderr)
                    except (json.JSONDecodeError, ValueError) as e:
                        print(f"⚠️ Failed to extract line_items from pattern: {e}", file=sys.stderr)
                        print(f"🔍 [FIX] JSON string (first 500 chars): {json_str[:500] if 'json_str' in locals() else 'N/A'}", file=sys.stderr)
                else:
                    print(f"⚠️ [FIX] Pattern search brace counting failed: found_start={found_start}, found_end={found_end}, match_start={match_start}", file=sys.stderr)
                    print(f"🔍 [FIX] Text around match (200 chars before, 200 after): ...{text[max(0, match_start-200):match_start]}>>>MATCH<<<{text[match_end:min(len(text), match_end+200)]}...", file=sys.stderr)

        if 'line_items' not in result:
            print(f"⚠️ WARNING: line_items not found in extracted result", file=sys.stderr)

        if 'compliance_validation' in text.lower():
            status_match = re.search(r'"compliance_status"\s*:\s*"([^"]+)"', text, re.IGNORECASE)
            if status_match:
                result['compliance_validation'] = {
                    'compliance_status': status_match.group(1),
                    'overall_score': 0.0,
                    'validation_rules': {'ro': [], 'en': []},
                    'errors': {'ro': [], 'en': []},
                    'warnings': {'ro': [], 'en': []}
                }
                print("Extracted basic compliance validation structure from patterns", file=sys.stderr)

        if result:
            print(f"Extracted structured data using patterns: {list(result.keys())}", file=sys.stderr)
            if 'compliance_validation' in result:
                if not validate_compliance_output(result):
                    print("WARNING: Invalid compliance validation format, attempting to fix...", file=sys.stderr)
                    validate_compliance_output(result)
            return result

    print(f"WARNING: Could not extract JSON from text (length: {len(text)})", file=sys.stderr)
    print(f"Text contains 'document_number': {'document_number' in text}", file=sys.stderr)
    print(f"Text contains 'document_date': {'document_date' in text}", file=sys.stderr)
    print(f"Text contains 'vendor': {'vendor' in text}", file=sys.stderr)
    print(f"Last 500 chars of text: {text[-500:]}", file=sys.stderr)

    return {}

def process_with_retry(crew_instance, inputs: dict, max_retries: int = 2) -> tuple[dict, bool]:
    """Process document with retry logic and validation."""
    for attempt in range(max_retries + 1):
        try:
            print(f"🔄 Processing attempt {attempt + 1}/{max_retries + 1} - Phase {crew_instance.processing_phase}", file=sys.stderr)

            captured_output = StringIO()

            print(f"⏰ Starting crew kickoff at {datetime.now().strftime('%H:%M:%S')}", file=sys.stderr)

            # Initialize variables that will be used across different code blocks
            doc_path = inputs.get('document_path', 'unknown')
            doc_type = None

            # Determine document type BEFORE redirect context
            if crew_instance.processing_phase == 1:
                phase0_data = inputs.get('phase0_data')
                if phase0_data:
                    try:
                        if isinstance(phase0_data, str):
                            import json
                            phase0_parsed = json.loads(phase0_data)
                            doc_type = phase0_parsed.get('document_type', '')
                        elif isinstance(phase0_data, dict):
                            doc_type = phase0_data.get('document_type', '')
                    except Exception as e:
                        print(f"Error parsing phase0_data: {e}", file=sys.stderr)

                if not doc_type:
                    doc_type = inputs.get('doc_type', '')

                # Standardize document type
                doc_type = standardize_document_type(doc_type)

                print(f"\n{'='*60}", file=sys.stderr)
                print(f"🎯 AGENT SELECTION - PHASE 1", file=sys.stderr)
                print(f"{'='*60}", file=sys.stderr)
                print(f"📄 Document: {os.path.basename(doc_path)}", file=sys.stderr)
                print(f"📋 Document Type: {doc_type}", file=sys.stderr)
                print(f"🎯 Specialized Agents Enabled: {crew_instance.use_specialized_agents}", file=sys.stderr)

                if doc_type and crew_instance.use_specialized_agents and doc_type in crew_instance.document_type_agents:
                    specialized_agent_name = crew_instance.document_type_agents[doc_type]
                    print(f"✅ SELECTED: Specialized {doc_type} agent ({specialized_agent_name})", file=sys.stderr)
                    print(f"💰 Expected: 10-15% cost reduction, 15-25% faster processing", file=sys.stderr)
                else:
                    print(f"❌ ERROR: Cannot process document", file=sys.stderr)
                    if not doc_type:
                        print(f"❌ Reason: No document type provided", file=sys.stderr)
                    elif not crew_instance.use_specialized_agents:
                        print(f"❌ Reason: Specialized agents disabled", file=sys.stderr)
                    elif doc_type not in crew_instance.document_type_agents:
                        print(f"❌ Reason: '{doc_type}' not supported", file=sys.stderr)
                        print(f"📋 Supported: {list(crew_instance.document_type_agents.keys())}", file=sys.stderr)
                print(f"{'='*60}\n", file=sys.stderr)

            # Re-enable output capture to prevent logs from polluting JSON output
            with redirect_stdout(captured_output), redirect_stderr(captured_output):
                if crew_instance.processing_phase == 1:
                    phase0_data = inputs.get('phase0_data')
                    if phase0_data:
                        try:
                            if isinstance(phase0_data, str):
                                import json
                                phase0_parsed = json.loads(phase0_data)
                                doc_type = phase0_parsed.get('document_type', '')
                                print(f"Parsed phase0_data from string: {phase0_parsed}", file=sys.stderr)
                            elif isinstance(phase0_data, dict):
                                doc_type = phase0_data.get('document_type', '')
                                print(f"Using phase0_data dict: {phase0_data}", file=sys.stderr)
                        except Exception as e:
                            print(f"Error parsing phase0_data: {e}", file=sys.stderr)

                    if not doc_type:
                        doc_type = inputs.get('doc_type', '')

                    # Standardize document type to match specialized agent keys
                    doc_type = standardize_document_type(doc_type)

                    print(f"Phase 1: Processing {doc_type} document", file=sys.stderr)

                    # Pass doc_type to crew (specialized agents handle routing internally)
                    print(f"🎯 Passing doc_type '{doc_type}' to crew", file=sys.stderr)
                    crew_obj = crew_instance.crew(document_type=doc_type)

                    # Log token monitoring for crew kickoff
                    if TOKEN_MONITORING_ENABLED:
                        log_function_call(
                            "crew_kickoff",
                            f"Phase_{crew_instance.processing_phase}",
                            inputs.get('document_path', 'unknown'),
                            prompt_tokens=0, completion_tokens=0, total_tokens=0
                        )

                    result = crew_obj.kickoff(inputs=inputs)
                else:
                    # Log token monitoring for crew kickoff
                    if TOKEN_MONITORING_ENABLED:
                        log_function_call(
                            "crew_kickoff",
                            f"Phase_{crew_instance.processing_phase}",
                            inputs.get('document_path', 'unknown'),
                            prompt_tokens=0, completion_tokens=0, total_tokens=0
                        )

                    result = crew_instance.crew().kickoff(inputs=inputs)

            print(f"⏰ Crew kickoff completed at {datetime.now().strftime('%H:%M:%S')}", file=sys.stderr)
            print(f"📊 Captured output length: {len(captured_output.getvalue())} chars", file=sys.stderr)

            # Enhanced logging for debugging crew output format
            print(f"🔍 CREW RESULT TYPE: {type(result)}", file=sys.stderr)
            print(f"🔍 CREW RESULT HAS TASKS_OUTPUT: {hasattr(result, 'tasks_output')}", file=sys.stderr)
            if hasattr(result, 'tasks_output'):
                print(f"🔍 CREW RESULT TASKS_OUTPUT LENGTH: {len(result.tasks_output) if result.tasks_output else 0}", file=sys.stderr)
                for i, task_output in enumerate(result.tasks_output or []):
                    if hasattr(task_output, 'raw'):
                        print(f"🔍 TASK {i} OUTPUT LENGTH: {len(task_output.raw) if task_output.raw else 0}", file=sys.stderr)
                        print(f"🔍 TASK {i} OUTPUT (first 500 chars): {task_output.raw[:500] if task_output.raw else 'None'}", file=sys.stderr)
                    else:
                        print(f"🔍 TASK {i} NO RAW OUTPUT", file=sys.stderr)

            # Log final agent usage summary AFTER processing
            if crew_instance.processing_phase == 1:
                print(f"\n{'='*60}", file=sys.stderr)
                print(f"✅ PROCESSING COMPLETE - PHASE 1", file=sys.stderr)
                print(f"{'='*60}", file=sys.stderr)
                print(f"📄 Document: {os.path.basename(doc_path)}", file=sys.stderr)
                print(f"📋 Document Type: {doc_type}", file=sys.stderr)

                if doc_type and crew_instance.use_specialized_agents and doc_type in crew_instance.document_type_agents:
                    specialized_agent_name = crew_instance.document_type_agents[doc_type]
                    print(f"✅ AGENT USED: Specialized {doc_type} agent ({specialized_agent_name})", file=sys.stderr)
                    print(f"💰 Cost optimized: ~10-15% savings", file=sys.stderr)
                else:
                    print(f"❌ WARNING: Document processing may have failed", file=sys.stderr)
                    print(f"📋 Document type '{doc_type}' should be supported", file=sys.stderr)
                print(f"{'='*60}\n", file=sys.stderr)

            # Log OpenAI usage metrics (including prompt caching!)
            if hasattr(result, 'usage_metrics'):
                usage = result.usage_metrics
                print(f"\n{'='*80}", file=sys.stderr)
                print(f"💰 OPENAI USAGE METRICS - Phase {crew_instance.processing_phase}", file=sys.stderr)
                print(f"{'='*80}", file=sys.stderr)

                # Total tokens
                total_tokens = usage.get('total_tokens', 0)
                prompt_tokens = usage.get('prompt_tokens', 0)
                completion_tokens = usage.get('completion_tokens', 0)

                print(f"📊 Total tokens: {total_tokens:,}", file=sys.stderr)
                print(f"📥 Prompt tokens: {prompt_tokens:,}", file=sys.stderr)
                print(f"📤 Completion tokens: {completion_tokens:,}", file=sys.stderr)

                # Prompt caching metrics (new in openai>=1.50.0)
                cache_creation_tokens = usage.get('cache_creation_input_tokens', 0) or usage.get('prompt_tokens_details', {}).get('cached_tokens', 0)
                cache_read_tokens = usage.get('cache_read_input_tokens', 0) or usage.get('prompt_tokens_details', {}).get('cached_tokens_read', 0)

                if cache_creation_tokens > 0:
                    print(f"💾 Cache creation tokens: {cache_creation_tokens:,} (cached for future reuse!)", file=sys.stderr)

                if cache_read_tokens > 0:
                    print(f"♻️  Cache read tokens: {cache_read_tokens:,} (90% DISCOUNT!)", file=sys.stderr)
                    print(f"💰 Savings: ${cache_read_tokens * 0.00045 / 1000:.4f} (90% off cached tokens)", file=sys.stderr)

                if cache_creation_tokens == 0 and cache_read_tokens == 0:
                    print(f"⚠️  NO PROMPT CACHING DETECTED!", file=sys.stderr)
                    print(f"⚠️  Check if openai>=1.50.0 is installed and RAG-200 is active", file=sys.stderr)

                # Cost estimate (gpt-4o-mini pricing)
                cost_input = prompt_tokens * 0.00015 / 1000  # $0.15 per 1M tokens
                cost_output = completion_tokens * 0.00060 / 1000  # $0.60 per 1M tokens
                cost_cache_write = cache_creation_tokens * 0.00015 / 1000 if cache_creation_tokens else 0
                cost_cache_read = cache_read_tokens * 0.000015 / 1000 if cache_read_tokens else 0  # 90% discount
                total_cost = cost_input + cost_output + cost_cache_write + cost_cache_read

                print(f"💵 Estimated cost: ${total_cost:.4f}", file=sys.stderr)

            combined_data = {
                "document_type": "Unknown",
                "line_items": [],
                "document_hash": inputs.get("document_hash", ""),
                "duplicate_detection": {"is_duplicate": False, "duplicate_matches": []},
                "compliance_validation": {"compliance_status": "PENDING", "validation_rules": {"ro": [], "en": []}, "errors": {"ro": [], "en": []}, "warnings": {"ro": [], "en": []}}
            }

            if hasattr(result, 'tasks_output') and result.tasks_output:
                print(f"Processing {len(result.tasks_output)} task outputs", file=sys.stderr)

                current_phase = inputs.get('processing_phase', crew_instance.processing_phase)
                print(f"Current processing phase: {current_phase}", file=sys.stderr)

                for i, task_output in enumerate(result.tasks_output):
                    try:
                        if task_output and hasattr(task_output, 'raw') and task_output.raw:
                            output_length = len(task_output.raw)
                            print(f"Task {i} output length: {output_length}", file=sys.stderr)
                            print(f"🐍 DEBUG Task {i} first 200 chars: {task_output.raw[:200]}", file=sys.stderr)

                            if current_phase == 0:

                                if i == 0:
                                    # CRITICAL: Log full text before extraction to diagnose truncation
                                    raw_text = task_output.raw if hasattr(task_output, 'raw') else str(task_output)
                                    print(f"🚨 [CRITICAL] PHASE 0: Raw text length: {len(raw_text)} chars", file=sys.stderr)
                                    print(f"🚨 [CRITICAL] PHASE 0: Has 'line_items': {'line_items' in raw_text}", file=sys.stderr)
                                    if 'line_items' in raw_text:
                                        isnew_count = raw_text.count('"isNew": false')
                                        print(f"🚨 [CRITICAL] PHASE 0: 'isNew': false count: {isnew_count} (expected: 29)", file=sys.stderr)
                                        # Check for missing items by name
                                        missing_items = [
                                            "Semințe de dovleac 50g",
                                            "Miez de floarea soarelui 30g",
                                            "Trufe pecan 90g",
                                            "Arahide cu ciocolată 90g",
                                            "Stafide cu ciocolată 90g",
                                            "Cappuccino crisp 80g"
                                        ]
                                        found_missing = [item for item in missing_items if item in raw_text or item.replace('ă', 'a') in raw_text]
                                        print(f"🚨 [CRITICAL] PHASE 0: Missing items (24-29) found in text: {len(found_missing)}/6 - {found_missing}", file=sys.stderr)
                                        # Log last 1000 chars to see where it ends
                                        print(f"🚨 [CRITICAL] PHASE 0: Last 1000 chars of raw text: ...{raw_text[-1000:]}", file=sys.stderr)

                                    categorization_data = extract_json_from_text(task_output.raw)
                                    if categorization_data and isinstance(categorization_data, dict):
                                        combined_data.update(categorization_data)
                                        doc_type = categorization_data.get('document_type', 'Unknown')
                                        print(f"Document categorized as: {doc_type}", file=sys.stderr)
                                        inputs['doc_type'] = doc_type
                                    else:
                                        print(f"🐍 DEBUG: Task 0 extraction failed or empty", file=sys.stderr)

                            elif current_phase == 1:
                                if i == 0:
                                    expected_doc_type = inputs.get('phase0_data', {}).get('document_type', inputs.get('doc_type', ''))

                                    raw_output = task_output.raw if hasattr(task_output, 'raw') else str(task_output)

                                    # CRITICAL: Log full text before extraction to diagnose truncation
                                    print(f"🚨 [CRITICAL] PHASE 1: Raw text length: {len(raw_output)} chars", file=sys.stderr)
                                    print(f"🚨 [CRITICAL] PHASE 1: Has 'line_items': {'line_items' in raw_output}", file=sys.stderr)

                                    # CRITICAL FIX: Check if line_items exist in raw output before extraction
                                    raw_has_line_items = '"line_items"' in raw_output or "'line_items'" in raw_output
                                    if raw_has_line_items and expected_doc_type and expected_doc_type.lower() == 'invoice':
                                        print(f"🔍 [FIX] Raw output contains 'line_items' pattern - extraction should find them", file=sys.stderr)

                                        # Count isNew markers in raw output
                                        isnew_count = raw_output.count('"isNew": false')
                                        print(f"🚨 [CRITICAL] PHASE 1: 'isNew': false count in RAW OUTPUT: {isnew_count} (expected: 29)", file=sys.stderr)

                                        # Check for missing items by name in raw output
                                        missing_items = [
                                            "Semințe de dovleac 50g",
                                            "Miez de floarea soarelui 30g",
                                            "Trufe pecan 90g",
                                            "Arahide cu ciocolată 90g",
                                            "Stafide cu ciocolată 90g",
                                            "Cappuccino crisp 80g"
                                        ]
                                        found_missing = []
                                        for item in missing_items:
                                            if item in raw_output or item.replace('ă', 'a') in raw_output or item.replace('ț', 't') in raw_output:
                                                found_missing.append(item)
                                        print(f"🚨 [CRITICAL] PHASE 1: Missing items (24-29) found in RAW OUTPUT: {len(found_missing)}/6 - {found_missing}", file=sys.stderr)

                                        # Log where line_items array starts and ends
                                        line_items_start = raw_output.find('"line_items"')
                                        if line_items_start >= 0:
                                            array_start_pos = raw_output.find('[', line_items_start)
                                            if array_start_pos >= 0:
                                                # Try to find where array ends
                                                bracket_count = 1
                                                array_end_pos = -1
                                                for j in range(array_start_pos + 1, min(len(raw_output), array_start_pos + 50000)):
                                                    if raw_output[j] == '[':
                                                        bracket_count += 1
                                                    elif raw_output[j] == ']':
                                                        bracket_count -= 1
                                                        if bracket_count == 0:
                                                            array_end_pos = j + 1
                                                            break
                                                if array_end_pos > 0:
                                                    array_content_preview = raw_output[array_start_pos:array_end_pos]
                                                    print(f"🚨 [CRITICAL] PHASE 1: line_items array found at position {array_start_pos}, ends at {array_end_pos} (length: {array_end_pos - array_start_pos} chars)", file=sys.stderr)
                                                    isnew_false_count = array_content_preview.count('"isNew": false')
                                                    print(f"🚨 [CRITICAL] PHASE 1: Array content 'isNew' count: {isnew_false_count}", file=sys.stderr)
                                                    print(f"🚨 [CRITICAL] PHASE 1: Last 500 chars of array: ...{array_content_preview[-500:]}", file=sys.stderr)
                                                else:
                                                    print(f"🚨 [CRITICAL] PHASE 1: Could not find closing bracket for line_items array!", file=sys.stderr)

                                        # Log last 2000 chars of raw output to see where it ends
                                        print(f"🚨 [CRITICAL] PHASE 1: Last 2000 chars of RAW OUTPUT: ...{raw_output[-2000:]}", file=sys.stderr)

                                    extraction_data = extract_json_from_text(raw_output)

                                    if extraction_data and isinstance(extraction_data, dict):
                                        # DEBUG: Track line items count for multi-page invoices
                                        if extraction_data.get('document_type', '').lower() == 'invoice':
                                            line_items_count = len(extraction_data.get('line_items', []))
                                            print(f"🔍 [DEBUG] Invoice extraction - line_items count: {line_items_count}", file=sys.stderr)

                                            # CRITICAL FIX: If raw output had line_items but extraction didn't find them, log warning
                                            if raw_has_line_items and line_items_count == 0:
                                                print(f"🚨 [FIX] WARNING: Raw output contained 'line_items' but extraction found 0 items!", file=sys.stderr)
                                                print(f"🚨 [FIX] This indicates a JSON extraction issue - check extract_json_from_text function", file=sys.stderr)

                                            if line_items_count > 0:
                                                print(f"🔍 [DEBUG] First item: {extraction_data.get('line_items', [])[0].get('name', 'N/A')[:50] if extraction_data.get('line_items') else 'N/A'}", file=sys.stderr)
                                                print(f"🔍 [DEBUG] Last item: {extraction_data.get('line_items', [])[-1].get('name', 'N/A')[:50] if extraction_data.get('line_items') else 'N/A'}", file=sys.stderr)
                                        # Reduced debug logging for performance
                                        # print(f"🐍 DEBUG: Task {i} extracted keys: {list(extraction_data.keys())}", file=sys.stderr)

                                        if not extraction_data.get('document_type') or extraction_data.get('document_type') == 'Unknown':
                                            if expected_doc_type and expected_doc_type.lower() != 'unknown':
                                                extraction_data['document_type'] = standardize_document_type(expected_doc_type)
                                                print(f"🐍 DEBUG: Preserved document_type from phase 0: {extraction_data['document_type']}", file=sys.stderr)

                                        # Check if AI returned meaningful data
                                        if expected_doc_type and expected_doc_type.lower() == 'invoice':
                                            has_critical_data = (
                                                extraction_data.get('vendor') or
                                                extraction_data.get('buyer') or
                                                extraction_data.get('total_amount') or
                                                (extraction_data.get('line_items') and len(extraction_data.get('line_items', [])) > 0)
                                            )
                                            if not has_critical_data:
                                                print(f"🚨 CRITICAL: AI extraction returned EMPTY data for invoice!", file=sys.stderr)
                                                print(f"🚨 TOKEN CONSUMPTION FIX: Skipping expensive retry to prevent token waste", file=sys.stderr)
                                                # CRITICAL FIX: Remove expensive AI retry to prevent token consumption
                                                print(f"💰 SAVED: Avoiding expensive OpenAI retry call that was consuming tokens", file=sys.stderr)
                                            else:
                                                print(f"✅ AI extraction returned meaningful invoice data", file=sys.stderr)

                                        # Enhanced data validation and fallback for empty responses
                                        if expected_doc_type and expected_doc_type.lower() == 'invoice':
                                            # Ensure critical invoice fields exist
                                            if not extraction_data.get('vendor'):
                                                extraction_data['vendor'] = ""
                                                print("WARNING: Missing vendor field, setting empty string", file=sys.stderr)
                                            if not extraction_data.get('buyer'):
                                                extraction_data['buyer'] = ""
                                                print("WARNING: Missing buyer field, setting empty string", file=sys.stderr)
                                            if not extraction_data.get('total_amount'):
                                                extraction_data['total_amount'] = 0
                                                print("WARNING: Missing total_amount field, setting 0", file=sys.stderr)
                                            if not extraction_data.get('document_date'):
                                                extraction_data['document_date'] = ""
                                                print("WARNING: Missing document_date field, setting empty string", file=sys.stderr)
                                            if not extraction_data.get('line_items') or not isinstance(extraction_data.get('line_items'), list):
                                                # Reduced logging for performance - only log critical info
                                                print(f"🚨 CRITICAL: Missing line_items in extraction! Keys: {list(extraction_data.keys())[:5]}...", file=sys.stderr)
                                                extraction_data['line_items'] = []
                                                print("⚠️ WARNING: Missing line_items field, setting empty array", file=sys.stderr)
                                            if not extraction_data.get('currency'):
                                                extraction_data['currency'] = "RON"
                                                print("WARNING: Missing currency field, defaulting to RON", file=sys.stderr)

                                        # ========== LINE ITEMS PRESERVATION DEBUG ==========
                                        print(f"🔍 [PRESERVE_DEBUG] Before update:", file=sys.stderr)
                                        line_items_before = combined_data.get('line_items', [])
                                        line_items_new = extraction_data.get('line_items', [])
                                        print(f"🔍 [PRESERVE_DEBUG] line_items_before: {len(line_items_before) if isinstance(line_items_before, list) else 'N/A'} items", file=sys.stderr)
                                        print(f"🔍 [PRESERVE_DEBUG] line_items_new: {len(line_items_new) if isinstance(line_items_new, list) else 'N/A'} items", file=sys.stderr)
                                        if isinstance(line_items_new, list) and len(line_items_new) > 0:
                                            print(f"🔍 [PRESERVE_DEBUG] New items range: item 1 to item {len(line_items_new)}", file=sys.stderr)

                                        combined_data.update(extraction_data)
                                        print(f"🔍 [PRESERVE_DEBUG] After update(), combined_data['line_items']: {combined_data.get('line_items')}", file=sys.stderr)

                                        # CRITICAL: Ensure line_items are preserved and not lost
                                        if line_items_new and len(line_items_new) > 0:
                                            combined_data['line_items'] = line_items_new
                                            print(f"✅ [PRESERVE_DEBUG] Using new line_items: {len(line_items_new)} items", file=sys.stderr)
                                        elif not line_items_new or len(line_items_new) == 0:
                                            if line_items_before and len(line_items_before) > 0:
                                                # Keep existing line items if new ones are empty
                                                combined_data['line_items'] = line_items_before
                                                print(f"⚠️ [PRESERVE_DEBUG] New extraction has no line items, preserving {len(line_items_before)} existing", file=sys.stderr)
                                            else:
                                                print(f"🚨 [PRESERVE_DEBUG] BOTH new and old line_items are empty/missing!", file=sys.stderr)

                                        print(f"🔍 [PRESERVE_DEBUG] Final combined_data['line_items']: {combined_data.get('line_items')} (len: {len(combined_data.get('line_items', [])) if isinstance(combined_data.get('line_items'), list) else 'N/A'})", file=sys.stderr)

                                        # Reduced debug logging for performance
                                        # print(f"🐍 DEBUG: combined_data after update: {list(combined_data.keys())}", file=sys.stderr)
                                    else:
                                        print(f"🐍 DEBUG: Task {i} extraction FAILED - no valid data returned", file=sys.stderr)
                                        if expected_doc_type and expected_doc_type.lower() != 'unknown':
                                            combined_data['document_type'] = standardize_document_type(expected_doc_type)
                                            print(f"🐍 DEBUG: Fallback - preserved document_type from phase 0: {combined_data['document_type']}", file=sys.stderr)

                                            # Create minimal invoice data structure
                                            if expected_doc_type.lower() == 'invoice':
                                                combined_data.update({
                                                    'vendor': '',
                                                    'buyer': '',
                                                    'total_amount': 0,
                                                    'document_date': '',
                                                    'line_items': [],
                                                    'currency': 'RON',
                                                    'vat_amount': 0
                                                })
                                                print("WARNING: Created minimal invoice structure due to extraction failure", file=sys.stderr)
                                elif i == 1:
                                    print(f"🐍 DEBUG: Processing Task {i} (Duplicate detection)", file=sys.stderr)
                                    try:
                                        duplicate_data = extract_json_from_text(task_output.raw)
                                        if duplicate_data and isinstance(duplicate_data, dict):
                                            combined_data['duplicate_detection'] = duplicate_data
                                            print(f"Duplicate detection completed: {duplicate_data.get('is_duplicate', False)}", file=sys.stderr)
                                    except Exception as dup_error:
                                        print(f"ERROR: Duplicate detection processing failed: {str(dup_error)}", file=sys.stderr)

                                elif i == 2:
                                    print(f"🐍 DEBUG: Processing Task {i} (Compliance validation)", file=sys.stderr)
                                    try:
                                        compliance_data = extract_json_from_text(task_output.raw)
                                        if compliance_data and isinstance(compliance_data, dict):
                                            combined_data['compliance_validation'] = compliance_data
                                            print(f"Compliance validation completed: {compliance_data.get('compliance_status', 'PENDING')}", file=sys.stderr)
                                    except Exception as comp_error:
                                        print(f"ERROR: Compliance validation processing failed: {str(comp_error)}", file=sys.stderr)
                            else:
                                print(f"🐍 DEBUG: Task {i} has no output or empty raw data", file=sys.stderr)

                    except Exception as e:
                        print(f"ERROR: Error processing task {i}: {str(e)}", file=sys.stderr)
                        continue

            if current_phase == 1:
                phase0_doc_type = inputs.get('phase0_data', {}).get('document_type')
                if phase0_doc_type and (not combined_data.get('document_type') or combined_data.get('document_type') == 'Unknown'):
                    combined_data['document_type'] = standardize_document_type(phase0_doc_type)
                    print(f"🐍 FINAL DEBUG: Restored document_type from phase 0: {combined_data['document_type']}", file=sys.stderr)

                if combined_data.get('document_type', '').lower() == 'invoice':
                    if inputs.get('direction'):
                        combined_data['direction'] = inputs.get('direction')

            is_valid, validation_errors = validate_processed_data(combined_data)

            # Check if we have meaningful data even if validation fails
            doc_type = combined_data.get('document_type', '').lower()
            has_meaningful_data = False

            if doc_type == 'invoice':
                has_meaningful_data = (
                    combined_data.get('vendor') or
                    combined_data.get('buyer') or
                    combined_data.get('total_amount') or
                    (combined_data.get('line_items') and len(combined_data.get('line_items', [])) > 0)
                )

            if is_valid or has_meaningful_data:
                print(f"✅ Processing successful on attempt {attempt + 1} (valid: {is_valid}, meaningful: {has_meaningful_data})", file=sys.stderr)
                return combined_data, True
            else:
                print(f"❌ Processing failed on attempt {attempt + 1}: {validation_errors}", file=sys.stderr)
                print(f"❌ No meaningful data extracted from document", file=sys.stderr)

                if attempt < max_retries:
                    print(f"🔄 Retrying processing (attempt {attempt + 2})", file=sys.stderr)
                    time.sleep(2)
                    continue
                else:
                    print("🚨 Max retries reached, extraction completely failed!", file=sys.stderr)
                    print("🚨 This indicates a serious issue with OCR, AI prompts, or Chart of Accounts loading", file=sys.stderr)
                    fallback = create_fallback_response(combined_data.get('document_type', 'Unknown'))
                    if combined_data.get('document_type'):
                        fallback['document_type'] = combined_data['document_type']
                    if combined_data.get('duplicate_detection'):
                        fallback['duplicate_detection'] = combined_data['duplicate_detection']
                    return fallback, False

        except Exception as e:
            print(f"Processing attempt {attempt + 1} failed with error: {str(e)}", file=sys.stderr)
            if attempt < max_retries:
                print(f"Retrying after error (attempt {attempt + 2})", file=sys.stderr)
                time.sleep(3)
                continue
            else:
                print("Max retries reached after errors, returning fallback response", file=sys.stderr)
                return create_fallback_response(), False

    return create_fallback_response(), False


def _resolve_phase1_doc_type(crew_instance, inputs: dict) -> str:
    """Determine the standardized document type for a Phase 1 extraction."""
    doc_type = ''
    phase0_data = inputs.get('phase0_data')
    if phase0_data:
        if isinstance(phase0_data, str):
            try:
                phase0_data = json.loads(phase0_data)
            except Exception:
                phase0_data = {}
        if isinstance(phase0_data, dict):
            doc_type = phase0_data.get('document_type', '') or ''
    if not doc_type:
        doc_type = inputs.get('doc_type', '') or ''
    return standardize_document_type(doc_type)


def process_with_direct_extraction(crew_instance, inputs: dict, max_retries: int = 2) -> tuple[dict, bool]:
    """Structured-output extraction path (no CrewAI).

    Drop-in replacement for process_with_retry: same ``(combined_data, success)``
    contract. Uses direct_extraction (OpenAI response_format=json_schema,
    strict=True) so output shape is guaranteed by the API rather than parsed
    from free text with a regex.
    """
    try:
        from direct_extraction import categorize_document, extract_document
    except ImportError:
        from .direct_extraction import categorize_document, extract_document
    try:
        import extraction_metrics
    except ImportError:
        from . import extraction_metrics

    phase = crew_instance.processing_phase
    doc_path = inputs.get('document_path', 'unknown')
    document_hash = inputs.get('document_hash', '')
    accounting_client_id = getattr(crew_instance, 'accounting_client_id', None)

    for attempt in range(max_retries + 1):
        meta: dict = {}
        doc_type_for_metrics = 'Unknown'
        try:
            print(f"🔄 Direct extraction attempt {attempt + 1}/{max_retries + 1} - Phase {phase}", file=sys.stderr)

            if phase == 0:
                data, meta = categorize_document(doc_path, inputs)
                doc_type = standardize_document_type(data.get('document_type', 'Unknown'))
                doc_type_for_metrics = doc_type
                conf0 = float(data.get('confidence', 0.0) or 0.0)
                combined_data = {
                    "document_type": doc_type,
                    "direction": data.get('direction'),
                    "confidence": conf0,
                    "aviz": data.get('aviz', False),
                    "document_hash": document_hash,
                }
                # task 2.5: a shaky type classification should be reviewed, not
                # cascaded blindly into the wrong type's extraction.
                try:
                    import validators as _validators0
                except ImportError:
                    from . import validators as _validators0
                if doc_type == 'Unknown' or conf0 < _validators0.PHASE0_CONFIDENCE_THRESHOLD:
                    combined_data["_needs_type_review"] = True
                success = doc_type != 'Unknown'

            else:
                doc_type = _resolve_phase1_doc_type(crew_instance, inputs)
                doc_type_for_metrics = doc_type
                if doc_type not in crew_instance.document_type_agents:
                    raise ValueError(f"Unsupported document type for extraction: {doc_type!r}")

                extra_instructions = ""
                if hasattr(crew_instance, 'get_dynamic_prompt_suffix'):
                    extra_instructions = crew_instance.get_dynamic_prompt_suffix(doc_type)
                data, meta = extract_document(doc_path, doc_type, inputs, extra_instructions)

                # Map structured per-field confidences back to the legacy
                # `_confidence` key the client expects.
                if 'confidence' in data and isinstance(data['confidence'], dict):
                    data['_confidence'] = data.pop('confidence')

                combined_data = dict(data)
                combined_data['document_type'] = doc_type
                combined_data['document_hash'] = document_hash

                # Preserve direction for invoices from phase 0 if the model omitted it.
                if doc_type == 'Invoice' and not combined_data.get('direction') and inputs.get('direction'):
                    combined_data['direction'] = inputs['direction']

                # Carry the phase-0 aviz (delivery-note) decision forward — the
                # invoice extraction task doesn't re-derive it, so trust phase 0.
                phase0 = inputs.get('phase0_data') or {}
                if isinstance(phase0, str):
                    try:
                        phase0 = json.loads(phase0)
                    except Exception:
                        phase0 = {}
                if isinstance(phase0, dict) and phase0.get('aviz') is True:
                    combined_data['aviz'] = True

                # Deterministic structural validation (task 7): grounds confidence
                # in checks the model can't fake (CUI checksum, IBAN mod-97, VAT
                # math, line-item sums, date plausibility) and overrides the
                # self-reported `_confidence` where a validator fired.
                try:
                    import validators as _validators
                except ImportError:
                    from . import validators as _validators
                try:
                    _val = _validators.validate_extraction(
                        doc_type, combined_data, inputs.get('current_date'))
                    combined_data['_validation'] = _val
                    combined_data['_confidence'] = _validators.merge_confidence(
                        combined_data.get('_confidence'), _val['field_confidence'])
                    # task 2.2: per-line confidence onto each line item (the
                    # frontend table already reads item["_confidence"]).
                    _validators.attach_line_item_confidence(combined_data, _val.get('checks'))
                    # task 2.3: don't let unverifiable free-text self-reports read
                    # as "high" — cap them below the high band.
                    combined_data['_confidence'] = _validators.cap_uncalibrated_confidence(
                        combined_data['_confidence'], set(_val.get('field_confidence', {}).keys()))
                    # task 2.5: surface the phase-0 categorization confidence on
                    # document_type so a shaky type shows in the same per-field
                    # confidence UI and flags the doc for review instead of
                    # silently cascading into the wrong type's extraction.
                    phase0_conf = phase0.get('confidence') if isinstance(phase0, dict) else None
                    if isinstance(phase0_conf, (int, float)):
                        combined_data.setdefault('_confidence', {})['document_type'] = float(phase0_conf)
                        if float(phase0_conf) < _validators.PHASE0_CONFIDENCE_THRESHOLD:
                            combined_data['_needs_type_review'] = True
                except Exception as _ve:
                    print(f"⚠️  structural validation failed (non-fatal): {_ve}", file=sys.stderr)

                # task 3.2: deterministic direction cross-check. The client EIN is
                # known and both party EINs were extracted, so direction is decidable
                # without trusting the model — correct it when the EINs disagree with
                # the model's (or phase-0's) call. Free; fixes the top cascade error.
                if doc_type == 'Invoice':
                    try:
                        inferred = _validators.infer_direction(
                            combined_data.get('vendor_ein'),
                            combined_data.get('buyer_ein'),
                            inputs.get('client_company_ein'),
                        )
                        if inferred and inferred != combined_data.get('direction'):
                            combined_data['_direction_corrected'] = {
                                'from': combined_data.get('direction'), 'to': inferred,
                            }
                            combined_data['direction'] = inferred
                    except Exception as _de:
                        print(f"⚠️  direction cross-check skipped (non-fatal): {_de}", file=sys.stderr)

                # Default container keys downstream expects.
                combined_data.setdefault('duplicate_detection', {
                    "is_duplicate": False, "duplicate_matches": [],
                    "document_hash": document_hash, "confidence": 0.0,
                })
                combined_data.setdefault('compliance_validation', {
                    "compliance_status": "PENDING", "overall_score": 0.0,
                    "validation_rules": {"ro": [], "en": []},
                    "errors": {"ro": [], "en": []}, "warnings": {"ro": [], "en": []},
                })

                # Success = shape is valid AND no critical field is empty.
                # Empty critical fields trigger the backoff retry below.
                is_valid, _ = validate_processed_data(combined_data)
                empty_now = extraction_metrics.compute_empty_fields(doc_type, combined_data)
                success = is_valid and len(empty_now) == 0

            # empty_fields only meaningful for Phase 1 (Phase 0 doesn't extract fields).
            empty_fields = (
                extraction_metrics.compute_empty_fields(doc_type_for_metrics, combined_data)
                if phase == 1 else []
            )
            extraction_metrics.record_extraction(
                phase=phase,
                document_type=doc_type_for_metrics,
                document_hash=document_hash,
                model=meta.get('model', ''),
                success=success,
                duration_ms=meta.get('duration_ms', 0),
                retry_count=attempt,
                prompt_tokens=meta.get('prompt_tokens'),
                completion_tokens=meta.get('completion_tokens'),
                line_item_count=len(combined_data.get('line_items', []) or []) if phase == 1 else None,
                empty_fields=empty_fields,
                accounting_client_id=accounting_client_id,
                extra={'cached_tokens': meta.get('cached_tokens', 0)},
            )

            if success or attempt == max_retries:
                return combined_data, success

            print(f"🔄 Empty/invalid extraction, retrying (attempt {attempt + 2})", file=sys.stderr)
            time.sleep(2 ** attempt)  # exponential backoff: 1s, 2s

        except Exception as e:
            print(f"❌ Direct extraction attempt {attempt + 1} failed: {e}", file=sys.stderr)
            print(f"Traceback:\n{traceback.format_exc()}", file=sys.stderr)
            extraction_metrics.record_extraction(
                phase=phase,
                document_type=doc_type_for_metrics,
                document_hash=document_hash,
                model=meta.get('model', ''),
                success=False,
                duration_ms=meta.get('duration_ms', 0),
                retry_count=attempt,
                error=str(e),
                accounting_client_id=accounting_client_id,
            )
            if attempt < max_retries:
                time.sleep(2 ** attempt)
                continue
            return create_fallback_response(), False

    return create_fallback_response(), False


def standardize_document_type(doc_type: str) -> str:
    """Standardize document type casing to match expected format."""
    if not doc_type:
        return "Unknown"

    doc_type_lower = doc_type.lower().strip()

    type_mapping = {
        'invoice': 'Invoice',
        'factură': 'Invoice',
        'factura': 'Invoice',
        'receipt': 'Receipt',
        'chitanță': 'Receipt',
        'chitanta': 'Receipt',
        'bank statement': 'Bank Statement',
        'extras de cont': 'Bank Statement',
        'contract': 'Contract',
        'z report': 'Z Report',
        'raport z': 'Z Report',
        'payment order': 'Payment Disposition',  # Map to disposition (orders not used)
        'ordin de plata': 'Payment Disposition',  # Map to disposition (orders not used)
        'dispozitie de plata': 'Payment Disposition',  # Cash operation - needs posting
        'collection order': 'Collection Disposition',  # Map to disposition (orders not used)
        'ordin de incasare': 'Collection Disposition',  # Map to disposition (orders not used)
        'dispozitie de incasare': 'Collection Disposition',  # Cash operation - needs posting
        'cmr': 'CMR',
        'scrisoare de transport': 'CMR',
        'vehicle registration certificate': 'Vehicle Registration Certificate',
        'registration certificate': 'Vehicle Registration Certificate',
        'talon': 'Vehicle Registration Certificate',
        'zulassungsbescheinigung': 'Vehicle Registration Certificate',
        'other': 'Other',
    }

    return type_mapping.get(doc_type_lower, doc_type.title())

def process_account_attribution(transaction_file_path: str) -> Dict[str, Any]:
    """Process account attribution for a bank transaction."""
    try:
        with open(transaction_file_path, 'r', encoding='utf-8') as f:
            transaction_data = json.load(f)

        client_company_ein = transaction_data.get('clientCompanyEin')
        chart_of_accounts = transaction_data.get('chartOfAccounts', '')

        existing_articles = get_existing_articles()
        management_records = {"Depozit Central": {}, "Servicii": {}}
        user_corrections = load_user_corrections(client_company_ein)

        crew_instance = FirstCrewFinova(
            client_company_ein,
            existing_articles,
            management_records,
            user_corrections,
            0
        )

        result = crew_instance.attribute_account_for_transaction(
            transaction_data,
            chart_of_accounts
        )

        return {"data": result}

    except Exception as e:
        print(f"ERROR: Account attribution failed: {str(e)}", file=sys.stderr)
        return {
            "error": str(e),
            "data": {
                "account_code": "628",
                "account_name": "Alte cheltuieli cu serviciile executate de terți",
                "confidence": 0.1,
                "reasoning": f"Attribution failed: {str(e)}"
            }
        }

def should_retry_document(result_data: Dict[str, Any], max_retries: int = 0) -> bool:
    """Check if a document should be retried based on extraction results."""
    if not result_data:
        return True

    # Check if document was marked for retry
    if result_data.get('_requires_retry'):
        retry_count = result_data.get('_retry_count', 0)
        if retry_count < max_retries:
            print(f"🔄 Document eligible for retry (attempt {retry_count + 1}/{max_retries})", file=sys.stderr)
            return True
        else:
            print(f"❌ Document exceeded max retries ({max_retries})", file=sys.stderr)
            return False

    # Check for empty invoice data
    if result_data.get('document_type', '').lower() == 'invoice':
        has_meaningful_data = (
            result_data.get('vendor') or
            result_data.get('buyer') or
            result_data.get('total_amount') or
            result_data.get('document_date') or
            (result_data.get('line_items') and len(result_data.get('line_items', [])) > 0)
        )

        if not has_meaningful_data:
            retry_count = result_data.get('_retry_count', 0)
            if retry_count < max_retries:
                print(f"🔄 Empty invoice data detected, eligible for retry (attempt {retry_count + 1}/{max_retries})", file=sys.stderr)
                return True

    return False

def process_retry_queue(documents: List[Dict[str, Any]], client_company_ein: str, max_retries: int = 0) -> List[Dict[str, Any]]:
    """Process documents that need retry based on empty responses."""
    retry_documents = []
    processed_documents = []

    for doc in documents:
        if should_retry_document(doc.get('data', {}), max_retries):
            retry_documents.append(doc)
            print(f"🔄 Adding to retry queue: {doc.get('filename', 'unknown')}", file=sys.stderr)
        else:
            processed_documents.append(doc)

    if retry_documents:
        print(f"🔄 Processing {len(retry_documents)} documents in retry queue...", file=sys.stderr)

        for doc in retry_documents:
            try:
                print(f"🔄 Retrying document: {doc.get('filename', 'unknown')}", file=sys.stderr)

                # Process with enhanced settings for retry
                result = process_single_document(
                    doc.get('filepath', ''),
                    client_company_ein,
                    processing_phase=1,
                    phase0_data=doc.get('phase0_data', {})
                )

                # Update the document with new results
                doc['data'] = result
                doc['lastAttempt'] = int(time.time() * 1000)
                doc['retryCount'] = doc.get('retryCount', 0) + 1

                # Check if retry was successful
                if not should_retry_document(result, max_retries):
                    print(f"✅ Retry successful for: {doc.get('filename', 'unknown')}", file=sys.stderr)
                    doc['state'] = 'processed'
                else:
                    print(f"❌ Retry still failed for: {doc.get('filename', 'unknown')}", file=sys.stderr)
                    doc['state'] = 'failed' if doc.get('retryCount', 0) >= max_retries else 'queued'

                processed_documents.append(doc)

            except Exception as e:
                print(f"❌ Retry processing failed for {doc.get('filename', 'unknown')}: {str(e)}", file=sys.stderr)
                doc['state'] = 'failed'
                processed_documents.append(doc)

    return processed_documents

def process_single_document(doc_path: str, client_company_ein: str, existing_documents: List[Dict] = None, processing_phase: int = 0, phase0_data: Dict[str, Any] = None, cached_text_file: str = None, user_corrections_file: str = None, accounting_client_id: str = None, is_neplatitor_tva: bool = False) -> Dict[str, Any]:
    """Process a single document with comprehensive token monitoring"""

    # Start token monitoring for this document
    if TOKEN_MONITORING_ENABLED:
        start_token_monitoring()
        start_realtime_monitoring(os.path.basename(doc_path), f"Phase_{processing_phase}")
        print(f"🔍 TOKEN MONITORING STARTED for document: {os.path.basename(doc_path)}", file=sys.stderr)
    print(f"=" * 80, file=sys.stderr)
    print(f"🔵 ENTRY: process_single_document - Phase {processing_phase}", file=sys.stderr)
    print(f"🔵 EIN: {client_company_ein}", file=sys.stderr)
    print(f"🔵 Doc: {os.path.basename(doc_path)}", file=sys.stderr)
    print(f"🎯 Specialized Agents: ENABLED (use_specialized_agents=True)", file=sys.stderr)
    print(f"=" * 80, file=sys.stderr)
    log_memory_usage("Before processing")

    # OPTION 3: Pre-extract text ONCE and cache it for all agents
    if not cached_text_file:
        # Create cache file path. Key on canonical content hash (SHA-256 of
        # file bytes) so it matches what the Node side writes/reads and the
        # per-tool cache below — see doc_hash.py.
        cache_dir = "/tmp/text_cache"
        os.makedirs(cache_dir, exist_ok=True)
        doc_hash = generate_document_hash(doc_path)
        cached_text_file = os.path.join(cache_dir, f"text_{doc_hash}.txt")

        # Extract text once if not already cached
        if not os.path.exists(cached_text_file):
            print(f"💾 CACHING: Extracting text ONCE for all agents...", file=sys.stderr)
            try:
                from crew import SimpleTextExtractorTool
                extractor = SimpleTextExtractorTool()
                extracted_text = extractor._run(doc_path)

                # Save to cache file
                with open(cached_text_file, 'w', encoding='utf-8') as f:
                    f.write(extracted_text)

                print(f"✅ CACHED: Text saved to {cached_text_file} ({len(extracted_text)} chars)", file=sys.stderr)
            except Exception as cache_err:
                print(f"❌ CACHE ERROR: Failed to pre-extract text: {cache_err}", file=sys.stderr)
                cached_text_file = None  # Fall back to per-agent extraction
        else:
            with open(cached_text_file, 'r', encoding='utf-8') as f:
                cached_len = len(f.read())
            print(f"♻️  CACHE HIT: Using pre-extracted text ({cached_len} chars)", file=sys.stderr)
    elif os.path.exists(cached_text_file):
        with open(cached_text_file, 'r', encoding='utf-8') as f:
            cached_len = len(f.read())
        print(f"♻️  CACHE HIT: Using provided cached text ({cached_len} chars)", file=sys.stderr)

    try:
        print(f"✅ Step 1: Checking API key", file=sys.stderr)
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            error_msg = "OPENAI_API_KEY environment variable not found"
            print(f"ERROR: {error_msg}", file=sys.stderr)
            return {
                "error": error_msg,
                "details": "Please set the OPENAI_API_KEY environment variable"
            }

        print(f"API Key info - Length: {len(api_key)}, Starts with 'sk-': {api_key.startswith('sk-')}", file=sys.stderr)

        try:
            import openai
            try:
                from model_config import get_extraction_llm_model
            except ImportError:
                from .model_config import get_extraction_llm_model
            try:
                from direct_extraction import (
                    _is_anthropic_model, _is_gemini_model, _is_openrouter_model)
            except ImportError:
                from .direct_extraction import (
                    _is_anthropic_model, _is_gemini_model, _is_openrouter_model)
            extraction_model = get_extraction_llm_model()
            # This preflight hits api.openai.com directly, so it can only validate an
            # OpenAI model. Non-OpenAI extraction providers (Anthropic / Gemini /
            # OpenRouter) are routed by the actual extraction call — testing their
            # model id here just 400s with "invalid model ID" and aborts the doc.
            # OPENAI_API_KEY presence is already checked above (embeddings still use it).
            if not (_is_anthropic_model(extraction_model)
                    or _is_gemini_model(extraction_model)
                    or _is_openrouter_model(extraction_model)):
                print("Testing direct OpenAI connection...", file=sys.stderr)
                client = openai.OpenAI(api_key=api_key)
                client.chat.completions.create(
                    model=extraction_model,
                    messages=[{"role": "user", "content": "test"}],
                    max_completion_tokens=5,
                    timeout=30,
                )
                print("Direct OpenAI API test PASSED", file=sys.stderr)
            else:
                print(f"Skipping OpenAI preflight: extraction model '{extraction_model}' "
                      f"is a non-OpenAI provider (routed at call time).", file=sys.stderr)
        except Exception as e:
            print(f"ERROR: Direct OpenAI API test FAILED: {str(e)}", file=sys.stderr)
            error_msg = str(e).lower()
            if "authentication" in error_msg or "api key" in error_msg or "unauthorized" in error_msg:
                return {
                    "error": "OpenAI API key is invalid or expired. Please check your API key.",
                    "details": str(e)
                }
            elif "rate limit" in error_msg:
                return {
                    "error": "OpenAI API rate limit exceeded. Please try again later.",
                    "details": str(e)
                }
            else:
                return {
                    "error": f"OpenAI API error: {str(e)}",
                    "details": str(e)
                }

        if not check_llm_configuration():
            return {
                "error": "LLM service not configured. Please set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable.",
                "details": "No valid LLM API key found in environment variables"
            }

        print(f"✅ Step 2: Loading context and articles", file=sys.stderr)

        # Try to load context from cache if accounting_client_id provided
        client_context = {}
        if accounting_client_id:
            try:
                # Add shared directory to path - try multiple possible locations
                current_file = os.path.abspath(__file__)
                # Try: agents/shared/context_loader.py
                possible_paths = [
                    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(current_file))), 'shared'),
                    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file)))), 'shared'),
                    os.path.join(os.path.dirname(current_file), '..', '..', '..', 'shared'),
                ]

                shared_loaded = False
                for shared_path in possible_paths:
                    if os.path.exists(shared_path) and os.path.exists(os.path.join(shared_path, 'context_loader.py')):
                        sys.path.insert(0, os.path.dirname(shared_path))
                        from shared.context_loader import load_client_context, get_articles, get_management_records
                        print(f"[AGENT] 🔍 Attempting to load context for accountingClientId {accounting_client_id}...", file=sys.stderr)
                        client_context = load_client_context(accounting_client_id)
                        if client_context:
                            primary_caen = client_context.get('primaryCaen', 'N/A')
                            secondary_count = len(client_context.get('secondaryCaenCodes', []))
                            prefs_count = len(client_context.get('accountCodePreferences', {}))
                            print(
                                f"✅ [AGENT] Loaded client context for accountingClientId {accounting_client_id}:\n"
                                f"   - Primary CAEN: {primary_caen}\n"
                                f"   - Secondary CAEN codes: {secondary_count}\n"
                                f"   - Learned preferences: {prefs_count}",
                                file=sys.stderr
                            )
                        else:
                            print(f"⚠️  [AGENT] No context found for accountingClientId {accounting_client_id}", file=sys.stderr)

                        # Try to load articles and management from cache
                        try:
                            cached_articles = get_articles(accounting_client_id)
                            if cached_articles:
                                existing_articles = cached_articles
                                print(f"✅ Loaded {len(existing_articles)} articles from cache", file=sys.stderr)
                            else:
                                existing_articles = get_existing_articles()
                                print(f"✅ Loaded {len(existing_articles)} articles from file", file=sys.stderr)
                        except Exception as articles_err:
                            print(f"⚠️  Failed to load articles from cache: {articles_err}, using file fallback", file=sys.stderr)
                            existing_articles = get_existing_articles()
                            print(f"✅ Loaded {len(existing_articles)} articles from file (fallback)", file=sys.stderr)

                        try:
                            cached_management = get_management_records(accounting_client_id)
                            if cached_management:
                                management_records = cached_management
                                print(f"✅ Loaded management records from cache", file=sys.stderr)
                            else:
                                management_records = {"Depozit Central": {}, "Servicii": {}}
                                print(f"✅ Using default management records", file=sys.stderr)
                        except Exception as mgmt_err:
                            print(f"⚠️  Failed to load management records from cache: {mgmt_err}, using defaults", file=sys.stderr)
                            management_records = {"Depozit Central": {}, "Servicii": {}}
                            print(f"✅ Using default management records (fallback)", file=sys.stderr)

                        shared_loaded = True
                        break

                if not shared_loaded:
                    print(f"⚠️  Shared context loader not found, using fallback", file=sys.stderr)
                    existing_articles = get_existing_articles()
                    management_records = {"Depozit Central": {}, "Servicii": {}}
            except Exception as e:
                print(f"⚠️  Failed to load context from cache: {e}", file=sys.stderr)
                # Use module-level traceback import (don't re-import locally to avoid shadowing)
                import traceback as tb_cache
                tb_cache.print_exc(file=sys.stderr)
                existing_articles = get_existing_articles()
                management_records = {"Depozit Central": {}, "Servicii": {}}
        else:
            existing_articles = get_existing_articles()
            management_records = {"Depozit Central": {}, "Servicii": {}}

        print(f"✅ Step 3: Loaded {len(existing_articles)} articles", file=sys.stderr)

        print(f"✅ Step 4: Loading user corrections", file=sys.stderr)
        user_corrections = load_user_corrections(client_company_ein, user_corrections_file)
        print(f"✅ Step 5: Loaded {len(user_corrections)} corrections", file=sys.stderr)

        print(f"✅ Step 6: Generating document hash", file=sys.stderr)
        document_hash = generate_document_hash(doc_path)
        print(f"✅ Step 7: Hash generated: {document_hash[:16]}...", file=sys.stderr)

        log_memory_usage("After loading config")

        try:
            print(f"✅ Step 8: Creating FirstCrewFinova instance (Phase {processing_phase})", file=sys.stderr)
            crew_instance = FirstCrewFinova(
                client_company_ein,
                existing_articles,
                management_records,
                user_corrections,
                processing_phase,
                use_specialized_agents=True,  # Enable specialized agents
                accounting_client_id=accounting_client_id,  # NEW: Pass for context loading
                client_context=client_context,  # NEW: Pass loaded context
                is_neplatitor_tva=is_neplatitor_tva  # NEW: Pass neplatitor TVA flag
            )
            print(f"✅ Step 9: FirstCrewFinova instance created successfully", file=sys.stderr)

        except Exception as e:
            print(f"ERROR: Failed to create CrewAI instance: {str(e)}", file=sys.stderr)
            return {
                "error": "Failed to initialize CrewAI. Check logs for details.",
                "details": str(e)
            }

        log_memory_usage("After crew creation")

        print(f"✅ Step 10: Processing document: {os.path.basename(doc_path)}", file=sys.stderr)

        current_date = datetime.now().strftime("%d/%m/%Y")
        print(f"Current date for validation: {current_date}", file=sys.stderr)

        # Step 10.1: Determine document type for specialized agents
        document_type = None
        if processing_phase == 1:
            print(f"\n{'='*60}", file=sys.stderr)
            print(f"🔍 DOCUMENT TYPE DETECTION", file=sys.stderr)
            print(f"{'='*60}", file=sys.stderr)

            # Try to get document type from phase0_data
            if phase0_data:
                document_type = phase0_data.get('document_type', '').strip()
                print(f"📋 Document type from phase0_data: {document_type}", file=sys.stderr)

            # If no document type from phase0_data, leave it empty (inputs not defined yet)
            # The inputs dict will be created later with doc_type from phase0_data
            if not document_type:
                print(f"📋 No document type available from phase0_data", file=sys.stderr)

            if document_type:
                print(f"✅ Document type detected: {document_type}", file=sys.stderr)
                print(f"🎯 Will attempt to use specialized agent for: {document_type}", file=sys.stderr)
                print(f"🔍 Document type value: '{document_type}' (type: {type(document_type)})", file=sys.stderr)
            else:
                print(f"❌ No document type detected", file=sys.stderr)
                print(f"⚠️  Will fall back to generic agent", file=sys.stderr)

            print(f"{'='*60}\n", file=sys.stderr)

        # Build relevant accounts shortlist (top 100) with caching to reduce prompt size
        relevant_accounts_str = ""
        try:
            cache_dir = "/tmp/coa_relevance"
            os.makedirs(cache_dir, exist_ok=True)
            shortlist_cache = os.path.join(cache_dir, f"{document_hash}_top100.txt")
            if os.path.exists(shortlist_cache):
                with open(shortlist_cache, "r", encoding="utf-8") as f:
                    relevant_accounts_str = f.read()
                print(f"✅ Loaded cached relevant accounts (len={len(relevant_accounts_str)})", file=sys.stderr)
            else:
                try:
                    from account_selector import select_relevant_accounts
                    doc_text = ""
                    if cached_text_file and os.path.exists(cached_text_file):
                        with open(cached_text_file, "r", encoding="utf-8") as f:
                            doc_text = f.read()
                    if not doc_text:
                        from .tools.simple_text_extractor import SimpleTextExtractorTool
                        text_extractor = SimpleTextExtractorTool()
                        doc_text = text_extractor._run(doc_path) or ""
                    relevant_accounts_str = select_relevant_accounts(doc_text, top_k=100)
                    with open(shortlist_cache, "w", encoding="utf-8") as f:
                        f.write(relevant_accounts_str)
                    print(f"✅ Generated relevant accounts (len={len(relevant_accounts_str)})", file=sys.stderr)
                except Exception as rag_e:
                    print(f"⚠️ RAG relevant accounts failed: {rag_e}", file=sys.stderr)
        except Exception as e:
            print(f"⚠️ Failed to build relevant accounts shortlist: {e}", file=sys.stderr)
            relevant_accounts_str = ""

        # Determine document type for conditional inputs
        doc_type = phase0_data.get("document_type", "Unknown") if phase0_data else "Unknown"

        # Base inputs for all document types
        inputs = {
            "document_path": doc_path,
            "client_company_ein": client_company_ein,
            "current_date": current_date,
            "processing_phase": processing_phase,
            "vendor_labels": ["Furnizor", "Vânzător", "Emitent", "Societate emitentă", "Prestator", "Societate"],
            "buyer_labels": ["Cumpărător", "Client", "Beneficiar", "Achizitor", "Societate client", "Destinatar"],
            "existing_documents": existing_documents or [],
            "document_hash": document_hash,
            "doc_type": doc_type,
            "direction": phase0_data.get("direction", "") if phase0_data else "",
            "referenced_numbers": phase0_data.get("referenced_numbers", []) if phase0_data else [],
            "phase0_data": phase0_data,
        }

        # Conditional inputs based on document type - only add what's needed
        # Invoices and Receipts need line items with articles, units, types
        if doc_type in ['Invoice', 'Receipt']:
            inputs["incoming_types"] = ["Nedefinit", "Marfuri", "Materii prime", "Materiale auxiliare", "Ambalaje", "Obiecte de inventar", "Amenajari provizorii", "Mat. spre prelucrare", "Mat. in pastrare/consig.", "Discount financiar intrari", "Combustibili", "Piese de schimb", "Alte mat. consumabile", "Discount comercial intrari", "Ambalaje SGR"]
            inputs["outgoing_types"] = ["Nedefinit", "Marfuri", "Produse finite", "Ambalaje", "Produse reziduale", "Semifabricate", "Discount financiar iesiri", "Servicii vandute", "Discount comercial iesiri", "Ambalaje SGR", "Taxa verde"]
            inputs["vat_rates"] = ["TWENTYONE", "NINETEEN", "ELEVEN", "NINE", "FIVE", "ZERO"]
            inputs["units_of_measure"] = ["BUCATA", "KILOGRAM", "LITRU", "METRU", "GRAM", "CUTIE", "PACHET", "PUNGA", "SET", "METRU_PATRAT", "METRU_CUB", "MILIMETRU", "CENTIMETRU", "TONA", "PERECHE", "SAC", "MILILITRU", "KILOWATT_ORA", "MINUT", "ORA", "ZI_DE_LUCRU", "LUNI_DE_LUCRU", "DOZA", "UNITATE_DE_SERVICE", "O_MIE_DE_BUCATI", "TRIMESTRU", "PROCENT", "KILOMETRU", "LADA", "DRY_TONE", "CENTIMETRU_PATRAT", "MEGAWATI_ORA", "ROLA", "TAMBUR", "SAC_PLASTIC", "PALET_LEMN", "UNITATE", "TONA_NETA", "HECTOMETRU_PATRAT", "FOAIE"]
            inputs["existing_articles"] = existing_articles
            inputs["management_records"] = management_records
            inputs["relevant_accounts"] = relevant_accounts_str or ""
        # Payment Dispositions need relevant accounts (expense/asset accounts: 1xx, 2xx, 3xx, 5xx, 6xx)
        elif doc_type == 'Payment Disposition':
            # Filter relevant accounts to only include expense (6xx) and asset (1xx, 2xx, 3xx, 5xx) accounts
            filtered_accounts = filter_accounts_by_class(relevant_accounts_str, allowed_classes=['1', '2', '3', '5', '6'])
            inputs["relevant_accounts"] = filtered_accounts or ""
        # Collection Dispositions need relevant accounts (revenue accounts: 7xx)
        elif doc_type == 'Collection Disposition':
            # Filter relevant accounts to only include revenue (7xx) accounts
            filtered_accounts = filter_accounts_by_class(relevant_accounts_str, allowed_classes=['7'])
            inputs["relevant_accounts"] = filtered_accounts or ""
        # Z Reports only need VAT rates
        elif doc_type == 'Z Report':
            inputs["vat_rates"] = ["TWENTYONE", "NINETEEN", "ELEVEN", "NINE", "FIVE", "ZERO"]
        # Payment Orders, Collection Orders, Bank Statements, Contracts don't need these arrays
        # They already have the base inputs which is sufficient

        print(f"🐍 TOKEN OPTIMIZATION: Document type '{doc_type}' - Added {len(inputs)} input keys", file=sys.stderr)

        print(f"🐍 DEBUG: relevant_accounts length: {len(inputs.get('relevant_accounts') or '')}", file=sys.stderr)
        print(f"🐍 DEBUG: inputs contains phase0_data: {'phase0_data' in inputs}", file=sys.stderr)
        print(f"🐍 DEBUG: phase0_data value: {inputs.get('phase0_data')}", file=sys.stderr)

        # Debug all inputs being passed to the crew
        print(f"🐍 DEBUG: All inputs keys: {list(inputs.keys())}", file=sys.stderr)

        print(f"✅ Step 11: Inputs prepared, {len(inputs)} keys", file=sys.stderr)

        if processing_phase == 1 and phase0_data:
            inputs["doc_type"] = phase0_data.get("document_type", "Unknown")
            inputs["direction"] = phase0_data.get("direction", "")
            inputs["referenced_numbers"] = phase0_data.get("referenced_numbers", [])
            print(f"Phase 1 inputs: doc_type={inputs['doc_type']}, direction={inputs['direction']}", file=sys.stderr)

        # Shared prompt fragments (task 9) — resolve {CONFIDENCE_CALIBRATION} etc.
        # in both the direct path and the legacy CrewAI kickoff interpolation.
        try:
            from prompt_fragments import inject_fragments
        except ImportError:
            from .prompt_fragments import inject_fragments
        inject_fragments(inputs)

        print(f"✅ Step 12: About to call extraction", file=sys.stderr)
        log_memory_usage("Before crew kickoff")

        print(f"🚀 ABOUT TO KICKOFF CREW - Phase {processing_phase}", file=sys.stderr)
        print(f"🚀 Document path: {os.path.basename(doc_path)}", file=sys.stderr)
        print(f"🚀 Client EIN: {client_company_ein}", file=sys.stderr)

        # Log token monitoring for crew kickoff
        if TOKEN_MONITORING_ENABLED:
            log_function_call(
                "process_with_retry",
                f"Phase_{processing_phase}",
                os.path.basename(doc_path),
                prompt_tokens=0, completion_tokens=0, total_tokens=0
            )

        # Default to the structured-output path (no CrewAI). Set
        # FINOVA_USE_DIRECT_EXTRACTION=false to fall back to the legacy
        # CrewAI path for comparison / rollback.
        use_direct = os.getenv('FINOVA_USE_DIRECT_EXTRACTION', 'true').lower() != 'false'
        if use_direct:
            print(f"🎯 Using DIRECT extraction (structured outputs, no CrewAI) - Phase {processing_phase}", file=sys.stderr)
            combined_data, success = process_with_direct_extraction(crew_instance, inputs)
        else:
            print(f"🐪 Using LEGACY CrewAI extraction - Phase {processing_phase}", file=sys.stderr)
            combined_data, success = process_with_retry(crew_instance, inputs)

        print(f"✅ EXTRACTION COMPLETED - Phase {processing_phase}", file=sys.stderr)

        # Force line `total`/`unit_price` to NET so the UI and accounting export
        # (which compute the document total as Σtotal + Σvat) don't double-tax a
        # VAT-INCLUSIVE receipt — e.g. a 100.06 RON bon fiscal shown as 116.04.
        # Self-detecting and conservative: net lines (invoices) are untouched.
        if processing_phase != 0 and isinstance(combined_data.get('line_items'), list):
            try:
                try:
                    import validators as _validators
                except ImportError:
                    from . import validators as _validators
                # Relabel any mislabelled per-line VAT rate from its printed amount
                # before net-normalization strips to net using that rate.
                _validators.reconcile_line_item_vat_rates(combined_data)
                _validators.normalize_line_items_to_net(combined_data)
                # Repair a fuel quantity↔unit_price swap (needs net `total`, run last).
                _validators.reconcile_fuel_quantity_unit_swap(combined_data)
            except Exception as _ne:
                print(f"⚠️  line-item net normalization failed (non-fatal): {_ne}", file=sys.stderr)

        if not success:
            print("Processing completed with fallback response", file=sys.stderr)

        # Check if this document should be retried
        #
        # CRITICAL FIX: Prevent infinite loops
        if combined_data.get('vendor') or combined_data.get('buyer') or combined_data.get('total_amount', 0) > 0:
            print(f"✅ Document has meaningful data, NOT retrying to prevent infinite loop", file=sys.stderr)
            combined_data.pop('_requires_retry', None)
            combined_data.pop('_retry_reason', None)

        if should_retry_document(combined_data):
            retry_count = combined_data.get('_retry_count', 0)
            combined_data['_retry_count'] = retry_count + 1
            combined_data['_retry_timestamp'] = int(time.time() * 1000)
            print(f"🔄 Document marked for retry (attempt {retry_count + 1}): {os.path.basename(doc_path)}", file=sys.stderr)

            # CRITICAL FIX: Don't retry if we already have meaningful data
            # This prevents infinite loops on documents that are actually processed
            if combined_data.get('vendor') or combined_data.get('buyer') or combined_data.get('total_amount', 0) > 0:
                print(f"✅ Document has meaningful data, NOT retrying to prevent infinite loop", file=sys.stderr)
                combined_data.pop('_requires_retry', None)
                combined_data.pop('_retry_reason', None)

        del crew_instance
        del existing_articles
        del management_records

        doc_type = (combined_data.get('document_type') or '').lower()

        if doc_type != 'invoice':
            invoice_only_fields = ['vendor_ein', 'buyer_ein', 'direction', 'vat_amount']
            for field in invoice_only_fields:
                if field in combined_data and not combined_data.get(field):
                    combined_data.pop(field, None)

        if doc_type == 'invoice' and processing_phase != 0:
            # CRITICAL: Invoices MUST have line_items in Phase 1 (full extraction).
            # Phase 0 is categorization only and should never retry-loop on missing line items.
            line_items = combined_data.get('line_items')
            if not line_items or not isinstance(line_items, list) or len(line_items) == 0:
                # Mark for retry - this is unacceptable in Phase 1
                combined_data['_requires_retry'] = True
                combined_data['_retry_reason'] = 'missing_line_items'
                combined_data['_retry_timestamp'] = int(time.time() * 1000)
                # Still set empty array for now, but mark as failed
                combined_data['line_items'] = []

        if doc_type == 'bank statement' and 'transactions' not in combined_data:
            combined_data['transactions'] = []
            print("WARNING: No transactions found for bank statement, setting empty array", file=sys.stderr)

        # Final safety check to prevent completely empty responses
        if doc_type == 'invoice' and processing_phase != 0:
            # CRITICAL: Line items are MANDATORY for invoices
            line_items = combined_data.get('line_items', [])
            has_line_items = line_items and isinstance(line_items, list) and len(line_items) > 0

            # DEBUG: Final line items count
            final_count = len(line_items) if isinstance(line_items, list) else 0
            print(f"🔍 [DEBUG] FINAL invoice line_items count: {final_count}", file=sys.stderr)
            if final_count > 0:
                print(f"🔍 [DEBUG] FINAL - First item name: {line_items[0].get('name', 'N/A')[:50]}", file=sys.stderr)
                print(f"🔍 [DEBUG] FINAL - Last item name: {line_items[-1].get('name', 'N/A')[:50]}", file=sys.stderr)

            if not has_line_items:
                print(f"🚨 CRITICAL FAILURE: Invoice has NO line items - THIS IS UNACCEPTABLE!", file=sys.stderr)
                print(f"🚨 Document: {os.path.basename(doc_path)}", file=sys.stderr)
                print(f"🚨 This invoice MUST be re-processed until line items are extracted!", file=sys.stderr)

                # Mark this document for retry - line items are mandatory
                combined_data['_requires_retry'] = True
                combined_data['_retry_reason'] = 'missing_line_items_mandatory'
                combined_data['_retry_timestamp'] = int(time.time() * 1000)

                print(f"🔄 Document marked for retry queue due to missing line items: {os.path.basename(doc_path)}", file=sys.stderr)

            # Check if we have any other meaningful data at all
            has_other_data = (
                combined_data.get('vendor') or
                combined_data.get('buyer') or
                combined_data.get('total_amount') or
                combined_data.get('document_date')
            )

            if not has_other_data and not has_line_items:
                print(f"🚨 CRITICAL: No meaningful data extracted from invoice document!", file=sys.stderr)
                print(f"🚨 This document should be re-queued for processing!", file=sys.stderr)

                # Mark this document for retry by adding a special flag
                combined_data['_requires_retry'] = True
                combined_data['_retry_reason'] = 'empty_extraction'
                combined_data['_retry_timestamp'] = int(time.time() * 1000)

                print(f"🔄 Document marked for retry queue: {os.path.basename(doc_path)}", file=sys.stderr)

            # Ensure all critical fields exist with fallback values
            critical_fields = {
                'vendor': '',
                'buyer': '',
                'total_amount': 0,
                'document_date': '',
                'line_items': [],
                'currency': 'RON',
                'vat_amount': 0
            }

            for field, default_value in critical_fields.items():
                if field not in combined_data or combined_data[field] is None:
                    combined_data[field] = default_value
                    print(f"FINAL SAFETY: Set missing {field} to {default_value}", file=sys.stderr)

            # Add debugging information for troubleshooting
            print(f"🔍 FINAL EXTRACTION DEBUG:", file=sys.stderr)
            print(f"   Document Type: {combined_data.get('document_type', 'Unknown')}", file=sys.stderr)
            print(f"   Vendor: '{combined_data.get('vendor', '')}'", file=sys.stderr)
            print(f"   Buyer: '{combined_data.get('buyer', '')}'", file=sys.stderr)
            print(f"   Total Amount: {combined_data.get('total_amount', 0)}", file=sys.stderr)
            print(f"   Document Date: '{combined_data.get('document_date', '')}'", file=sys.stderr)
            print(f"   Line Items Count: {len(combined_data.get('line_items', []))}", file=sys.stderr)
            print(f"   Currency: '{combined_data.get('currency', '')}'", file=sys.stderr)
            print(f"   VAT Amount: {combined_data.get('vat_amount', 0)}", file=sys.stderr)

        if 'duplicate_detection' not in combined_data:
            combined_data['duplicate_detection'] = {
                "is_duplicate": False,
                "duplicate_matches": [],
                "document_hash": document_hash,
                "confidence": 0.0
            }

        if 'compliance_validation' not in combined_data:
            combined_data['compliance_validation'] = {
                "compliance_status": "PENDING",
                "overall_score": 0.0,
                "validation_rules": {"ro": [], "en": []},
                "errors": {"ro": [], "en": []},
                "warnings": {"ro": [], "en": []}
            }

        log_memory_usage("After processing")

        print(f"🐍 FINAL DEBUG: About to return combined_data with keys: {list(combined_data.keys())}", file=sys.stderr)
        print(f"🐍 FINAL DEBUG: receipt_number in final data: {combined_data.get('receipt_number')}", file=sys.stderr)
        print(f"🐍 FINAL DEBUG: vendor in final data: {combined_data.get('vendor')}", file=sys.stderr)
        print(f"🐍 FINAL DEBUG: total_amount in final data: {combined_data.get('total_amount')}", file=sys.stderr)
        print(f"🐍 FINAL DEBUG: Full combined_data: {json.dumps(combined_data, default=str)[:1000]}...", file=sys.stderr)


        # Stop token monitoring and generate report
        if TOKEN_MONITORING_ENABLED:
            stop_token_monitoring()
            stop_realtime_monitoring()
            print(f"🔍 TOKEN MONITORING COMPLETED for document: {os.path.basename(doc_path)}", file=sys.stderr)

        return {"data": combined_data}

    except Exception as e:
        print(f"ERROR: Unhandled exception in process_single_document: {str(e)}", file=sys.stderr)
        print(f"Traceback:\n{traceback.format_exc()}", file=sys.stderr)

        error_message = str(e)
        if any(keyword in error_message.lower() for keyword in ["api", "key", "authentication", "unauthorized", "forbidden"]):
            return {"error": "LLM API authentication failed. Please check your API key.", "details": error_message}
        elif any(keyword in error_message for keyword in ["LLM", "OpenAI", "rate limit", "quota"]):
            return {"error": "LLM service error. Please check API configuration or try again later.", "details": error_message}
        elif "memory" in error_message.lower() or "killed" in error_message.lower():
            return {"error": "Memory limit exceeded. Please try with a smaller document.", "details": error_message}
        elif "timeout" in error_message.lower():
            return {"error": "Processing timeout. Please try with a simpler document.", "details": error_message}

        return {"error": f"Processing failed: {str(e)}"}

    finally:
        # Do NOT call log_memory_usage() here — psutil can hang indefinitely on some hosts (Render),
        # blocking return to main() so JSON never reaches stdout and Node hits Processing timeout.
        cleanup_memory()

def read_base64_from_file(file_path: str) -> str:
    """Read base64 data from file with error handling."""
    try:
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Base64 file not found: {file_path}")

        file_size = os.path.getsize(file_path)
        max_size = 100 * 1024 * 1024

        if file_size > max_size:
            raise ValueError(f"Base64 file too large: {file_size // 1024 // 1024}MB")

        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()

        if not content:
            raise ValueError("Empty base64 file")

        print(f"Read base64 file: {file_path} ({file_size // 1024}KB)", file=sys.stderr)
        return content

    except Exception as e:
        print(f"ERROR: Error reading base64 file: {str(e)}", file=sys.stderr)
        raise

def main():
    """Main function with comprehensive error handling and memory management."""

    # Batch-scan segmentation: `python main.py segment <base64_file>` — detects
    # logical document boundaries in a multi-page PDF (see segmentation.py).
    # Fail-open: segment_document itself never raises (falls back to a
    # single-segment result), so exit(1) here means infrastructure failure
    # (unreadable input file), which the Node caller also treats as "don't split".
    if len(sys.argv) >= 3 and sys.argv[1] == 'segment':
        print(
            "[CONFIG] segmentation: "
            f"dpi={os.getenv('FINOVA_SEGMENT_DPI', '100')} "
            f"max_dim={os.getenv('FINOVA_SEGMENT_MAX_DIM', '800')} "
            f"max_pages={os.getenv('FINOVA_SEGMENT_MAX_PAGES', '40')} "
            f"min_confidence={os.getenv('FINOVA_SEGMENT_MIN_CONFIDENCE', '0.7')} "
            f"model={os.getenv('FINOVA_SEGMENT_LLM_MODEL') or os.getenv('FINOVA_EXTRACTION_LLM_MODEL', 'gpt-4o-mini-2024-07-18')}",
            file=sys.stderr,
        )
        try:
            from segmentation import segment_document
        except ImportError:
            from .segmentation import segment_document  # type: ignore
        try:
            # Optional 3rd arg: a previously decided partition to replay
            # (idempotent fan-out retries) — see segment_document(forced=...).
            forced_segments = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
            base64_data = read_base64_from_file(sys.argv[2].strip())
            temp_file_path = save_temp_file(base64_data)
            try:
                result = segment_document(temp_file_path, forced=forced_segments)
            finally:
                if os.path.exists(temp_file_path):
                    os.remove(temp_file_path)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: segment mode failed: {e}", file=sys.stderr)
            print(json.dumps({"error": str(e)}, ensure_ascii=False), flush=True)
            sys.exit(1)

    if len(sys.argv) >= 3 and sys.argv[1] == 'account_attribution':
        transaction_file_path = sys.argv[2]

        try:
            result = process_account_attribution(transaction_file_path)
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(0)
        except Exception as e:
            error_result = {
                "error": str(e),
                "data": {
                    "account_code": "628",
                    "account_name": "Alte cheltuieli cu serviciile executate de terți",
                    "confidence": 0.1
                }
            }
            print(json.dumps(error_result, ensure_ascii=False))
            sys.exit(1)

    print(f"Python script started", file=sys.stderr)
    print(f"Python version: {sys.version}", file=sys.stderr)
    print(f"OPENAI_API_KEY exists: {bool(os.getenv('OPENAI_API_KEY'))}", file=sys.stderr)
    print(f"MODEL env var: {os.getenv('MODEL', 'NOT SET')}", file=sys.stderr)
    print(f"Current working directory: {os.getcwd()}", file=sys.stderr)

    # [CONFIG] self-check — log the extraction config this process ACTUALLY reads, so
    # an eval↔prod skew (champion levers silently OFF in prod) is visible in the logs
    # instead of producing degraded output that looks like a model failure.
    print(
        "[CONFIG] extraction: "
        f"vision={os.getenv('FINOVA_VISION_EXTRACTION', 'true')} "
        f"textract_analyze={os.getenv('FINOVA_TEXTRACT_ANALYZE', 'true')} "
        f"bank_chunking={os.getenv('FINOVA_BANK_CHUNKING', 'true')} "
        f"repair_scoped={os.getenv('FINOVA_REPAIR_SCOPED', 'true')} "
        f"vision_max_dim={os.getenv('FINOVA_VISION_MAX_DIM', '1600')} "
        f"model={os.getenv('FINOVA_EXTRACTION_LLM_MODEL', 'gpt-4o-mini-2024-07-18')}",
        file=sys.stderr,
    )

    try:
        import crewai
        print(f"CrewAI version: {crewai.__version__ if hasattr(crewai, '__version__') else 'unknown'}", file=sys.stderr)
    except ImportError as e:
        print(f"ERROR: Cannot import crewai: {e}", file=sys.stderr)

    try:
        import openai
        print(f"OpenAI version: {openai.__version__ if hasattr(openai, '__version__') else 'unknown'}", file=sys.stderr)
    except ImportError as e:
        print(f"ERROR: Cannot import openai: {e}", file=sys.stderr)

    memory_monitoring = setup_memory_monitoring()

    try:
        if len(sys.argv) < 7:
            result = {"error": "Usage: python main.py <client_company_ein> <base64_file_data_or_file_path> <existing_documents_json> <user_corrections_file> <existing_articles_file> <processing_phase> [accounting_client_id] [phase0_data] [cached_text_file]"}
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(1)

        client_company_ein = sys.argv[1].strip()
        base64_input = sys.argv[2].strip()
        existing_documents_file = sys.argv[3].strip()
        user_corrections_file = sys.argv[4].strip()
        existing_articles_file = sys.argv[5].strip()
        processing_phase = int(sys.argv[6].strip())
        accounting_client_id = sys.argv[7].strip() if len(sys.argv) > 7 else None  # NEW: accountingClientId for context
        is_neplatitor_tva = sys.argv[8].strip().lower() == 'true' if len(sys.argv) > 8 else False  # NEW: isNeplatitorTva flag
        phase0_data = json.loads(sys.argv[9].strip()) if len(sys.argv) > 9 else None

        # NEW: Cached text file (optional, for Phase 1 optimization)
        cached_text_file = sys.argv[10].strip() if len(sys.argv) > 10 else None

        existing_documents = []
        if os.path.exists(existing_documents_file):
            with open(existing_documents_file, 'r') as f:
                existing_documents = json.load(f)

        print(f"📥 Reading base64 data from {base64_input}", file=sys.stderr)
        base64_data = read_base64_from_file(base64_input)
        print(f"📥 Base64 data read: {len(base64_data)} chars", file=sys.stderr)

        print(f"💾 Saving temp file", file=sys.stderr)
        temp_file_path = save_temp_file(base64_data)
        print(f"💾 Temp file saved: {temp_file_path}", file=sys.stderr)

        try:
            # Debug trace (FINOVA_DEBUG_TRACE=1): observe every pipeline stage and
            # attach the trace to the result as `_debug` so it rides to the report.
            try:
                from debug_trace import TRACE as _TRACE
            except ImportError:
                from .debug_trace import TRACE as _TRACE  # type: ignore
            try:
                _TRACE.reset(os.path.basename(temp_file_path))
            except Exception:
                pass

            print(f"🎯 Calling process_single_document - Phase {processing_phase}", file=sys.stderr)
            result = process_single_document(temp_file_path, client_company_ein, existing_documents, processing_phase, phase0_data, cached_text_file, user_corrections_file, accounting_client_id, is_neplatitor_tva)
            print(f"✅ process_single_document completed", file=sys.stderr)
            sys.stderr.flush()
            try:
                _dbg = _TRACE.as_dict()
                if _dbg and isinstance(result, dict):
                    result["_debug"] = _dbg
            except Exception:
                pass
            # flush=True so Node receives JSON before any finally blocks that might hang (psutil/tracemalloc)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        finally:
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)

    except KeyboardInterrupt:
        print("Processing interrupted by user", file=sys.stderr)
        print(json.dumps({"error": "Processing interrupted"}))
        sys.exit(1)

    except Exception as e:
        print(f"ERROR: Unhandled error in main: {str(e)}", file=sys.stderr)
        print(f"Traceback:\n{traceback.format_exc()}", file=sys.stderr)
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    finally:
        # Keep exit path light — psutil in log_memory_usage can stall the process on some hosts.
        try:
            cleanup_memory()
        except Exception:
            pass
        try:
            if memory_monitoring and tracemalloc.is_tracing():
                tracemalloc.stop()
        except Exception:
            pass

if __name__ == "__main__":
    main()
