from crewai import Agent, Crew, Task, LLM
from crewai.project import CrewBase, agent, crew, task
from crewai.tools import BaseTool
from typing import List, Dict, Type, Optional
import os
import json
import traceback
import sys
from pydantic import BaseModel, Field
import logging
import hashlib
import re


try:
    from .tools.serper_tool import get_serper_tool
except ImportError:
    try:
        from tools.serper_tool import get_serper_tool
    except ImportError:
        print("Warning: Serper tool not available", file=sys.stderr)
        def get_serper_tool():
            return None

try:
    from crewai import Process
except ImportError:
    from crewai.process import Process

try:
    import PyPDF2
    PYPDF2_AVAILABLE = True
except ImportError:
    PYPDF2_AVAILABLE = False

try:
    from llm_vision_ocr_tool import LLMVisionTextExtractorTool
    LLM_VISION_AVAILABLE = True
except ImportError:
    LLM_VISION_AVAILABLE = False
    try:
        OCR_TOOL_AVAILABLE = True
    except ImportError:
        OCR_TOOL_AVAILABLE = False

try:
    from aws_textract_tool import AWSTextractExtractor
    AWS_TEXTRACT_AVAILABLE = True
except ImportError:
    AWS_TEXTRACT_AVAILABLE = False


def _force_textract() -> bool:
    """Skip the PyPDF2-first shortcut and always use AWS Textract.

    PyPDF2 returns text for text-based PDFs but linearizes tables just like
    DetectDocumentText. Set FINOVA_FORCE_TEXTRACT=true to route every PDF
    through Textract — needed to A/B the AnalyzeDocument (TABLES+FORMS) path on
    text PDFs, where PyPDF2 would otherwise short-circuit it."""
    return os.getenv('FINOVA_FORCE_TEXTRACT', 'false').lower() == 'true'


class FileReadInput(BaseModel):
    """Input schema for FileReadTool."""
    file_path: str = Field(..., description="Path to the file to read")

class DuplicateCheckInput(BaseModel):
    """Input schema for duplicate checking."""
    document_data: dict = Field(..., description="Current document data for comparison")
    existing_documents: List[dict] = Field(..., description="List of existing documents to compare against")

class SimpleTextExtractorTool(BaseTool):
    name: str = "simple_text_extractor"
    description: str = "Text extraction with PyPDF2 & AWS Textract fallback"
    args_schema: Type[BaseModel] = FileReadInput

    # Class-level cache to detect infinite loops
    _extraction_cache: dict = {}

    def _run(self, file_path: str) -> str:
        """Extract text from files. Uses PyPDF2 for text PDFs, falls back to OpenAI Vision for image-based PDFs."""
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        # OPTION 3: Check for cached text file first.
        # Key on canonical content hash (SHA-256 of file bytes) so the cache is
        # shared with the Node side and main.py — see doc_hash.py.
        try:
            from doc_hash import sha256_file
        except ImportError:
            from .doc_hash import sha256_file
        doc_hash = sha256_file(file_path)
        cached_text_file = f"/tmp/text_cache/text_{doc_hash}.txt"

        if os.path.exists(cached_text_file):
            sys.stderr.write(f"\n{'='*80}\n")
            sys.stderr.write(f"♻️  CACHE HIT: Reading pre-extracted text from cache\n")
            sys.stderr.write(f"📄 Document: {os.path.basename(file_path)}\n")
            sys.stderr.flush()
            try:
                with open(cached_text_file, 'r', encoding='utf-8') as f:
                    cached_text = f.read()
                # Too-small cache = a failed/empty prior extraction (e.g. PyPDF2
                # on a scanned PDF). Treat as a miss so we re-extract here.
                if len(cached_text.strip()) >= 50:
                    sys.stderr.write(f"✅ CACHE: Loaded {len(cached_text)} chars from cache (NO extraction needed!)\n")
                    sys.stderr.write(f"💰 COST: $0.00 (cache hit, multiple agents share same text!)\n")
                    sys.stderr.write(f"{'='*80}\n\n")
                    sys.stderr.flush()
                    return cached_text
                sys.stderr.write(f"♻️  CACHE too small ({len(cached_text.strip())} chars), re-extracting\n")
                sys.stderr.flush()
            except Exception as cache_err:
                sys.stderr.write(f"❌ CACHE READ ERROR: {cache_err}, will extract fresh\n")
                sys.stderr.flush()

        # LOOP DETECTION: Check if we've already extracted this file
        file_key = f"{file_path}_{os.path.getmtime(file_path)}"
        if file_key in self._extraction_cache:
            call_count = self._extraction_cache[file_key]['count']
            if call_count >= 2:
                sys.stderr.write(f"\n⚠️  WARNING: File already extracted {call_count} times! Returning cached result.\n")
                sys.stderr.write(f"⚠️  This prevents infinite loops.\n\n")
                sys.stderr.flush()
                return self._extraction_cache[file_key]['text']
            else:
                self._extraction_cache[file_key]['count'] += 1
                sys.stderr.write(f"\n🔄 Re-extraction attempt #{call_count + 1} for: {os.path.basename(file_path)}\n\n")
                sys.stderr.flush()
        else:
            self._extraction_cache[file_key] = {'count': 1, 'text': None}

        def _extract_with_textract(path: str) -> str:
            """Extract text using AWS Textract (cost-effective and faster than Vision API)."""
            try:
                if not AWS_TEXTRACT_AVAILABLE:
                    sys.stderr.write(f"❌ AWS Textract not available (boto3 not installed)\n")
                    sys.stderr.flush()
                    return ""

                sys.stderr.write(f"🔄 Using AWS Textract for extraction...\n")
                sys.stderr.flush()

                # Initialize Textract extractor
                textract_tool = AWSTextractExtractor()
                extracted_text = textract_tool._run(path)

                # Check if extraction was successful
                if extracted_text.startswith("ERROR:"):
                    sys.stderr.write(f"❌ AWS Textract failed: {extracted_text}\n")
                    sys.stderr.flush()
                    return ""

                sys.stderr.write(f"✅ AWS Textract extracted {len(extracted_text)} characters\n")
                sys.stderr.flush()
                return extracted_text

            except Exception as e:
                sys.stderr.write(f"❌ AWS Textract extraction failed: {type(e).__name__}: {e}\n")
                sys.stderr.flush()
                import traceback
                sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
                sys.stderr.flush()
                return ""

        if file_path.lower().endswith(".pdf"):
            # Use sys.stderr.write to bypass CrewAI capture
            sys.stderr.write(f"\n{'='*80}\n")
            sys.stderr.write(f"📄 PDF EXTRACTION: {os.path.basename(file_path)}\n")
            sys.stderr.write(f"📄 PyPDF2 available: {PYPDF2_AVAILABLE}\n")
            sys.stderr.flush()

            if PYPDF2_AVAILABLE and not _force_textract():
                try:
                    sys.stderr.write(f"⚡ Trying PyPDF2 extraction (FREE)...\n")
                    sys.stderr.flush()
                    import time
                    start_time = time.time()

                    with open(file_path, "rb") as f:
                        reader = PyPDF2.PdfReader(f)

                        # OPTION 2: Better error logging
                        num_pages = len(reader.pages)
                        is_encrypted = reader.is_encrypted
                        sys.stderr.write(f"📊 PDF Info: {num_pages} pages, encrypted: {is_encrypted}\n")
                        sys.stderr.flush()

                        if is_encrypted:
                            sys.stderr.write(f"🔒 PDF is encrypted, attempting to decrypt...\n")
                            sys.stderr.flush()
                            try:
                                reader.decrypt('')  # Try empty password
                            except Exception as decrypt_err:
                                sys.stderr.write(f"❌ Decryption failed: {decrypt_err}\n")
                                sys.stderr.flush()

                        # Extract text from all pages with page markers for multi-page documents
                        page_texts = []
                        for i, page in enumerate(reader.pages, 1):
                            page_text = page.extract_text() or ""
                            if page_text.strip():
                                if num_pages > 1:
                                    page_texts.append(f"=== PAGE {i} ===\n{page_text}")
                                else:
                                    page_texts.append(page_text)
                        extracted = "\n\n".join(page_texts) if page_texts else ""

                    elapsed = time.time() - start_time
                    sys.stderr.write(f"⚡ PyPDF2 extracted {len(extracted)} chars from {num_pages} page(s) in {elapsed:.2f}s\n")
                    # DEBUG: Count page markers
                    page_marker_count = extracted.count("=== PAGE")
                    sys.stderr.write(f"🔍 [DEBUG] Page markers found in extracted text: {page_marker_count}\n")
                    sys.stderr.flush()

                    # Show sample of extracted text for debugging
                    if extracted:
                        sample = extracted[:200].replace('\n', '\\n')
                        sys.stderr.write(f"📝 Sample text: '{sample}...'\n")
                    else:
                        sys.stderr.write(f"⚠️  No text extracted at all!\n")
                    sys.stderr.flush()

                    # Page-aware sufficiency: a multi-page PDF that yields only a
                    # handful of chars per page is a scanned/image PDF whose text
                    # layer PyPDF2 can't read (e.g. a 9-page bank statement → 151
                    # chars). A flat ">100" accepted that garbage and starved the
                    # model (it then worked from vision alone and mis-read the
                    # debit/credit columns). Require ~40 chars/page so scanned
                    # multi-page docs escalate to Textract OCR instead.
                    min_text_chars = max(100, 40 * num_pages)
                    if len(extracted.strip()) > min_text_chars:
                        sys.stderr.write(f"✅ PyPDF2 SUCCESS! Using FREE extraction ({len(extracted)} chars)\n")
                        sys.stderr.write(f"💰 COST: $0.00 (saved $0.02!)\n")
                        sys.stderr.write(f"{'='*80}\n\n")
                        sys.stderr.flush()

                        # Cache the result
                        self._extraction_cache[file_key]['text'] = extracted
                        return extracted
                    else:
                        sys.stderr.write(f"⚠️  PyPDF2 extracted too little ({len(extracted.strip())} chars < {min_text_chars} for {num_pages}p), trying AWS Textract\n")
                        sys.stderr.write(f"🔍 Reason: Likely a scanned/image-based PDF\n")
                        sys.stderr.flush()
                except Exception as e:
                    sys.stderr.write(f"❌ PyPDF2 failed: {type(e).__name__}: {str(e)}\n")
                    import traceback
                    sys.stderr.write(f"📍 Traceback: {traceback.format_exc()}\n")
                    sys.stderr.flush()
            else:
                if _force_textract():
                    sys.stderr.write(f"⏭️  FINOVA_FORCE_TEXTRACT set — skipping PyPDF2, using AWS Textract\n")
                else:
                    sys.stderr.write(f"❌ PyPDF2 not available, using AWS Textract\n")
                sys.stderr.flush()

            sys.stderr.write(f"🔄 Falling back to AWS Textract (will cost ~$0.0015 per page)...\n")
            sys.stderr.flush()

            try:
                textract_result = _extract_with_textract(file_path)
                if textract_result and len(textract_result.strip()) > 50:
                    sys.stderr.write(f"✅ AWS Textract SUCCESS! Extracted {len(textract_result)} chars\n")
                    sys.stderr.write(f"💰 COST: ~$0.0015 per page (66% cheaper than Vision API!)\n")
                    sys.stderr.write(f"{'='*80}\n\n")
                    sys.stderr.flush()

                    # Cache the result
                    self._extraction_cache[file_key]['text'] = textract_result
                    return textract_result
                else:
                    sys.stderr.write(f"❌ AWS Textract returned insufficient text ({len(textract_result) if textract_result else 0} chars)\n")
                    sys.stderr.flush()
                    return "Could not extract text from PDF (PyPDF2 and AWS Textract both failed)."
            except Exception as e:
                sys.stderr.write(f"❌ FATAL: AWS Textract exception: {str(e)}\n")
                sys.stderr.write(f"{'='*80}\n\n")
                sys.stderr.flush()
                return f"ERROR: AWS Textract failed - {str(e)}"

        # Image documents (phone-photo receipts, scans saved as JPG/PNG) must be
        # OCR'd via Textract. Without this they fell through to the text reader
        # below, which decodes the raw image bytes as latin-1 garbage.
        if file_path.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.bmp')):
            sys.stderr.write(f"🖼️  Image document → AWS Textract OCR: {os.path.basename(file_path)}\n")
            sys.stderr.flush()
            image_text = _extract_with_textract(file_path)
            if image_text and len(image_text.strip()) > 20:
                self._extraction_cache[file_key]['text'] = image_text
                return image_text
            sys.stderr.write("❌ AWS Textract returned no text for image document\n")
            sys.stderr.flush()
            return "Could not extract text from image via AWS Textract."

        for enc in ("utf-8", "latin-1", "windows-1250"):
            try:
                with open(file_path, "r", encoding=enc) as f:
                    return f.read()
            except UnicodeDecodeError:
                continue
        return ""

class DocumentHashTool(BaseTool):
    name: str = "document_hash_generator"
    description: str = "Generate hash for document content to detect exact duplicates"
    args_schema: Type[BaseModel] = FileReadInput

    def _run(self, file_path: str) -> str:
        """Canonical document hash: SHA-256 of content (see doc_hash.py)."""
        try:
            from doc_hash import sha256_file
        except ImportError:
            from .doc_hash import sha256_file
        return sha256_file(file_path)

class ComplianceMessageTranslator:
    """Helper class for generating bilingual compliance messages"""

    @staticmethod
    def get_bilingual_message(key, **kwargs):
        """Get bilingual message for a specific validation rule/error/warning"""
        messages = {
            'invalid_vat': {
                'ro': f"Numărul de TVA invalid: {kwargs.get('vat', 'N/A')}",
                'en': f"Invalid VAT number: {kwargs.get('vat', 'N/A')}"
            },
            'future_date': {
                'ro': f"Dată în viitor detectată: {kwargs.get('date', 'N/A')}",
                'en': f"Future date detected: {kwargs.get('date', 'N/A')}"
            },
            'invalid_iban': {
                'ro': "Format IBAN invalid (trebuie RO + 22 cifre)",
                'en': "Invalid IBAN format (must be RO + 22 digits)"
            },
            'missing_field': {
                'ro': f"Câmp obligatoriu lipsă: {kwargs.get('field', 'N/A')}",
                'en': f"Missing required field: {kwargs.get('field', 'N/A')}"
            },
            'vat_calculation_error': {
                'ro': "Eroare în calculul TVA",
                'en': "VAT calculation error"
            },
            'foreign_currency': {
                'ro': f"Document în valută străină ({kwargs.get('currency', 'N/A')}) - verificați declararea",
                'en': f"Foreign currency document ({kwargs.get('currency', 'N/A')}) - verify declaration"
            },
            'vat_format_rule': {
                'ro': "Numărul de TVA trebuie să aibă format valid (RO + 2-10 cifre)",
                'en': "VAT number must have valid format (RO + 2-10 digits)"
            },
            'date_validation_rule': {
                'ro': "Data facturii nu poate fi în viitor",
                'en': "Invoice date cannot be in the future"
            },
            'iban_format_rule': {
                'ro': "IBAN-ul trebuie să aibă formatul RO + 22 cifre",
                'en': "IBAN must have format RO + 22 digits"
            }
        }
        return messages.get(key, {'ro': 'Mesaj necunoscut', 'en': 'Unknown message'})

class EnhancedDuplicateDetectionTool(BaseTool):
    name: str = "enhanced_duplicate_detector"
    description: str = "Advanced duplicate document detection with improved accuracy and document type filtering"
    args_schema: Type[BaseModel] = DuplicateCheckInput

    def _run(self, document_data: dict, existing_documents: List[dict]) -> str:
        """Enhanced duplicate detection with better accuracy."""
        current_doc = document_data
        duplicates = []

        current_normalized = self._normalize_document(current_doc)

        print(f"[DUPLICATE_DETECTION] Checking document type: {current_normalized.get('document_type')}")
        print(f"[DUPLICATE_DETECTION] Against {len(existing_documents)} existing documents")

        same_type_docs = []
        for existing_doc in existing_documents:
            existing_normalized = self._normalize_document(existing_doc)

            if (current_normalized.get('document_type') and existing_normalized.get('document_type') and
                current_normalized['document_type'] == existing_normalized['document_type']):
                same_type_docs.append((existing_doc, existing_normalized))

        print(f"[DUPLICATE_DETECTION] Found {len(same_type_docs)} documents of same type to compare")

        for existing_doc, existing_normalized in same_type_docs:
            if (current_doc.get('document_hash') and existing_doc.get('document_hash') and
                current_doc['document_hash'] == existing_doc['document_hash']):
                duplicates.append({
                    "document_id": existing_doc.get('id'),
                    "similarity_score": 1.0,
                    "matching_fields": ['document_hash'],
                    "duplicate_type": "EXACT_MATCH",
                    "reason": "Identical file content (hash match)"
                })
                continue

            similarity_result = self._calculate_similarity(current_normalized, existing_normalized)

            if similarity_result['score'] >= 0.85:
                duplicate_type = "EXACT_MATCH"
            elif similarity_result['score'] >= 0.70:
                duplicate_type = "CONTENT_MATCH"
            elif similarity_result['score'] >= 0.60:
                duplicate_type = "SIMILAR_CONTENT"
            else:
                continue

            duplicates.append({
                "document_id": existing_doc.get('id'),
                "similarity_score": similarity_result['score'],
                "matching_fields": similarity_result['fields'],
                "duplicate_type": duplicate_type,
                "reason": similarity_result['reason']
            })

        is_duplicate = len(duplicates) > 0

        print(f"[DUPLICATE_DETECTION] Result: {len(duplicates)} potential duplicates found")
        if duplicates:
            for dup in duplicates:
                print(f"  - {dup['duplicate_type']}: {dup['reason']} (score: {dup['similarity_score']:.2f})")

        return json.dumps({
            "is_duplicate": is_duplicate,
            "duplicate_matches": duplicates,
            "document_hash": current_doc.get('document_hash', ''),
            "confidence": max([d['similarity_score'] for d in duplicates]) if duplicates else 0.0
        })

    def _normalize_document(self, doc: dict) -> dict:
        """Normalize document fields for consistent comparison."""
        normalized = {}

        normalized['document_type'] = doc.get('document_type', '').lower().strip()

        doc_num = doc.get('document_number', '')
        if doc_num:
            normalized['document_number'] = str(doc_num).strip().upper().replace(' ', '').replace('-', '').lstrip('0')
        else:
            normalized['document_number'] = ''

        for field in ['total_amount', 'vat_amount']:
            amount = doc.get(field)
            if amount is not None:
                try:
                    normalized[field] = round(float(amount), 2)
                except (ValueError, TypeError):
                    normalized[field] = 0.0
            else:
                normalized[field] = 0.0

        date_str = doc.get('document_date', '')
        normalized['document_date'] = self._normalize_date(date_str)

        for field in ['vendor_ein', 'buyer_ein']:
            ein = doc.get(field, '')
            if ein:
                normalized[field] = str(ein).strip().upper().replace('RO', '').replace(' ', '')
            else:
                normalized[field] = ''

        for field in ['vendor', 'buyer']:
            name = doc.get(field, '')
            if name:
                normalized[field] = self._normalize_company_name(str(name))
            else:
                normalized[field] = ''

        normalized['currency'] = doc.get('currency', 'RON').upper()

        return normalized

    def _normalize_date(self, date_str: str) -> str:
        """Normalize date to DD-MM-YYYY format."""
        if not date_str:
            return ''

        date_str = str(date_str).strip()

        if re.match(r'^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$', date_str):
            parts = re.split(r'[\/\-]', date_str)
            return f"{parts[0].zfill(2)}-{parts[1].zfill(2)}-{parts[2]}"

        if re.match(r'^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$', date_str):
            parts = re.split(r'[\/\-]', date_str)
            return f"{parts[2].zfill(2)}-{parts[1].zfill(2)}-{parts[0]}"

        return date_str

    def _normalize_company_name(self, name: str) -> str:
        """Normalize company name for comparison."""
        name = name.upper().strip()
        suffixes = ['SRL', 'SA', 'SRA', 'PFA', 'II', 'IF', 'LLC', 'LTD', 'INC']
        for suffix in suffixes:
            name = re.sub(rf'\b{suffix}\.?\b$', '', name).strip()
        name = re.sub(r'\s+', ' ', name)
        return name

    def _calculate_similarity(self, current: dict, existing: dict) -> dict:
        """Calculate detailed similarity between documents with document-type specific logic."""
        score = 0.0
        matching_fields = []
        reasons = []

        doc_type = current.get('document_type', '')

        doc_num_weight = 0.5 if doc_type == 'invoice' else 0.4  # Higher weight for invoices
        if (current.get('document_number') and existing.get('document_number') and
            current['document_number'] == existing['document_number']):
            score += doc_num_weight
            matching_fields.append('document_number')
            reasons.append(f"Same document number: {current['document_number']}")

        if (current.get('total_amount') and existing.get('total_amount')):
            amount_diff = abs(current['total_amount'] - existing['total_amount'])
            if amount_diff < 0.01:  # Exact match
                score += 0.3
                matching_fields.append('total_amount')
                reasons.append(f"Exact amount match: {current['total_amount']}")
            elif amount_diff < 1.0:  # Very close amounts
                score += 0.15
                matching_fields.append('total_amount_close')
                reasons.append(f"Similar amounts: {current['total_amount']} vs {existing['total_amount']}")

        if (current.get('document_date') and existing.get('document_date')):
            if current['document_date'] == existing['document_date']:
                score += 0.15
                matching_fields.append('document_date')
                reasons.append(f"Same date: {current['document_date']}")
            else:
                if doc_type != 'invoice':
                    date_diff = self._calculate_date_difference(current['document_date'], existing['document_date'])
                    if date_diff <= 7:  # Within a week
                        score += 0.05
                        matching_fields.append('document_date_close')
                        reasons.append(f"Close dates: {current['document_date']} vs {existing['document_date']}")

        if doc_type in ['invoice', 'receipt']:
            vendor_weight = 0.15
            if (current.get('vendor_ein') and existing.get('vendor_ein') and
                current['vendor_ein'] == existing['vendor_ein']):
                score += vendor_weight
                matching_fields.append('vendor_ein')
                reasons.append(f"Same vendor EIN: {current['vendor_ein']}")
            elif (current.get('vendor') and existing.get('vendor') and
                  self._company_names_similar(current['vendor'], existing['vendor'])):
                score += vendor_weight * 0.7  # Partial match for name similarity
                matching_fields.append('vendor_name')
                reasons.append(f"Similar vendor names: {current['vendor']} vs {existing['vendor']}")

        if current.get('currency') == existing.get('currency'):
            score += 0.05
            matching_fields.append('currency')

        if doc_type == 'invoice' and len([f for f in matching_fields if not f.endswith('_close')]) >= 3:
            score += 0.1
            reasons.append("Multiple exact field matches bonus")

        return {
            'score': min(score, 1.0),  # Cap at 1.0
            'fields': matching_fields,
            'reason': '; '.join(reasons) if reasons else 'Field similarities detected'
        }

    def _company_names_similar(self, name1: str, name2: str) -> bool:
        """Check if company names are similar enough."""
        if not name1 or not name2:
            return False

        if name1 == name2:
            return True

        if len(name1) > 5 and len(name2) > 5:
            shorter = name1 if len(name1) < len(name2) else name2
            longer = name2 if len(name1) < len(name2) else name1
            if shorter in longer:
                return True

        words1 = set(name1.split())
        words2 = set(name2.split())
        common_words = words1.intersection(words2)

        if len(common_words) >= 2 and len(common_words) >= min(len(words1), len(words2)) * 0.6:
            return True

        return False

    def _calculate_date_difference(self, date1: str, date2: str) -> int:
        """Calculate difference in days between two dates."""
        try:
            from datetime import datetime

            d1 = datetime.strptime(date1, '%d-%m-%Y')
            d2 = datetime.strptime(date2, '%d-%m-%Y')

            return abs((d1 - d2).days)
        except:
            return 999

def get_text_extractor_tool():
    # FORCE SimpleTextExtractorTool with PyPDF2 optimization
    # (LLMVisionTextExtractorTool doesn't have PyPDF2 and calls Vision API for everything)
    sys.stderr.write("🔧 FORCING SimpleTextExtractorTool with PyPDF2 (cost optimization)\n")
    sys.stderr.flush()
    return SimpleTextExtractorTool()

def get_configured_llm(temperature: float = 0.3, max_tokens: int = None):
    """Get properly configured LLM for CrewAI agents.

    temperature defaults to 0.3 for extraction tasks. Deterministic tasks such
    as bank-transaction account attribution pass temperature=0 so the same
    transaction always maps to the same account code in bookkeeping records.

    max_tokens defaults to the centralized, env-tunable DEFAULT_MAX_TOKENS.
    NOTE: the legacy CrewAI path shares one LLM across the crew, so it can't do
    true per-task budgets — the default (direct) path sets max_tokens per
    document type via model_config.get_extraction_max_tokens (task 10).
    """

    openai_api_key = os.getenv('OPENAI_API_KEY')
    try:
        from model_config import get_extraction_llm_model, DEFAULT_MAX_TOKENS
    except ImportError:
        from .model_config import get_extraction_llm_model, DEFAULT_MAX_TOKENS
    model_name = get_extraction_llm_model()
    if max_tokens is None:
        max_tokens = int(os.getenv('FINOVA_MAXTOK_DEFAULT', DEFAULT_MAX_TOKENS))

    if not openai_api_key:
        print("ERROR: OPENAI_API_KEY environment variable not found", file=sys.stderr)
        return None

    try:
        from crewai import LLM
        print("Importing LLM from crewai...", file=sys.stderr)

        llm_kwargs = dict(model=model_name, temperature=temperature, max_tokens=max_tokens)
        # Non-OpenAI provider slugs (e.g. "google/gemini-3.1-flash-lite") make
        # CrewAI try to load a native provider package (crewai[google-genai]) that
        # isn't installed → ImportError. The active path is DIRECT extraction
        # (OpenRouter, see direct_extraction.py); this legacy CrewAI LLM is only a
        # fallback. Disable the native provider so litellm handles routing.
        try:
            llm = LLM(use_native=False, **llm_kwargs)
        except TypeError:
            # Older/newer CrewAI without the use_native kwarg.
            llm = LLM(**llm_kwargs)

        print(f"LLM configuration successful: model={model_name}, temp={temperature}, max_tokens={max_tokens}", file=sys.stderr)
        return llm

    except Exception as e:
        # Known, non-fatal case: native provider package absent for a non-OpenAI
        # model. The direct-extraction path is unaffected, so log a one-liner
        # instead of a multi-frame traceback that reads like a crash.
        if "native provider not available" in str(e):
            print(
                f"⚠️  CrewAI native provider unavailable for '{model_name}'; "
                f"legacy CrewAI LLM disabled (direct extraction is unaffected)",
                file=sys.stderr,
            )
        else:
            print(f"ERROR: Failed to configure LLM: {str(e)}", file=sys.stderr)
            print(f"Traceback:\n{traceback.format_exc()}", file=sys.stderr)
        return None

@CrewBase
class FirstCrewFinova:
    """FirstCrewFinova crew for document categorization and data extraction"""

    agents_config = 'config/agents.yaml'
    tasks_config = 'config/tasks.yaml'

    def __init__(self, client_company_ein: str, existing_articles: Dict, management_records: Dict, user_corrections: List[Dict] = None, processing_phase: int = 0, use_specialized_agents: bool = True, accounting_client_id: str = None, client_context: Dict = None, is_neplatitor_tva: bool = False):
        self.client_company_ein = client_company_ein
        self.existing_articles = existing_articles
        self.management_records = management_records
        self.user_corrections = user_corrections or []
        self.processing_phase = processing_phase
        self.use_specialized_agents = use_specialized_agents
        self.accounting_client_id = accounting_client_id
        self.client_context = client_context or {}
        self.is_neplatitor_tva = is_neplatitor_tva
        self.llm = get_configured_llm()
        # Dedicated deterministic LLM (temperature=0) for account attribution,
        # lazily created on first use. See account_attribution_agent().
        self._attribution_llm = None

        # Extract account code mappings from LINE_ITEMS corrections
        self.account_code_mappings = self._extract_account_code_mappings()

        # Extract CAEN info from context (with safe fallbacks)
        try:
            self.primary_caen = self.client_context.get('primaryCaen', '') or ''
            self.primary_caen_description = self.client_context.get('primaryCaenDescription', '') or ''
            secondary_raw = self.client_context.get('secondaryCaenCodes', [])
            self.secondary_caen_codes = secondary_raw if isinstance(secondary_raw, list) else []
            prefs_raw = self.client_context.get('accountCodePreferences', {})
            self.account_preferences = prefs_raw if isinstance(prefs_raw, dict) else {}
        except Exception as e:
            print(f"⚠️  Error extracting context data: {e}, using defaults", file=sys.stderr)
            self.primary_caen = ''
            self.primary_caen_description = ''
            self.secondary_caen_codes = []
            self.account_preferences = {}

        # Document type → agent. One generic 'document_extractor' for all types;
        # the per-type behavior lives in the task prompts (document_type_tasks).
        # Kept as a dict (rather than a constant) so it still doubles as the set
        # of supported types used for routing/validation.
        self.document_type_agents = {
            'Invoice': 'document_extractor',
            'Receipt': 'document_extractor',
            'Bank Statement': 'document_extractor',
            'Contract': 'document_extractor',
            'Z Report': 'document_extractor',
            'Payment Disposition': 'document_extractor',
            'Collection Disposition': 'document_extractor',
            'CMR': 'document_extractor',
            'Vehicle Registration Certificate': 'document_extractor',
            'Other': 'document_extractor',
            'Payment Order': 'document_extractor',  # Backward compatibility
            'Collection Order': 'document_extractor'  # Backward compatibility
        }

        # Document type to task mapping for specialized agents
        self.document_type_tasks = {
            'Invoice': 'extract_invoice_data_task',
            'Receipt': 'extract_receipt_data_task',
            'Bank Statement': 'extract_bank_statement_data_task',
            'Contract': 'extract_contract_data_task',
            'Z Report': 'extract_z_report_data_task',
            'Payment Disposition': 'extract_payment_disposition_data_task',
            'Collection Disposition': 'extract_collection_disposition_data_task',
            'CMR': 'extract_cmr_data_task',
            'Vehicle Registration Certificate': 'extract_vehicle_registration_data_task',
            'Other': 'extract_other_document_data_task',
            'Payment Order': 'extract_payment_disposition_data_task',  # Backward compatibility
            'Collection Order': 'extract_collection_disposition_data_task'  # Backward compatibility
        }

        import os
        print(f"Current working directory: {os.getcwd()}", file=sys.stderr)
        print(f"Looking for agents config at: {self.agents_config}", file=sys.stderr)
        print(f"Agents config file exists: {os.path.exists(self.agents_config)}", file=sys.stderr)
        print(f"🎯 SPECIALIZED AGENTS: {'ENABLED' if self.use_specialized_agents else 'DISABLED'}", file=sys.stderr)
        if self.use_specialized_agents:
            print(f"📋 Supported document types: {list(self.document_type_agents.keys())}", file=sys.stderr)

        config_dir = os.path.dirname(self.agents_config) if self.agents_config else 'config'
        print(f"Config directory '{config_dir}' exists: {os.path.exists(config_dir)}", file=sys.stderr)

        if os.path.exists(config_dir):
            files_in_config = os.listdir(config_dir)
            print(f"Files in config directory: {files_in_config}", file=sys.stderr)

    def _extract_account_code_mappings(self) -> Dict[str, str]:
        """
        Extract account code mappings from LINE_ITEMS corrections.
        Returns a dictionary mapping line item descriptions to account codes.
        """
        mappings = {}
        if not self.user_corrections:
            return mappings

        line_item_corrections = [c for c in self.user_corrections if c.get('correctionType') == 'LINE_ITEMS']

        for correction in line_item_corrections:
            original_items = correction.get('originalValue', {}).get('line_items', [])
            corrected_items = correction.get('correctedValue', {}).get('line_items', [])

            # Match original and corrected items by index or description
            for orig_item, corr_item in zip(original_items, corrected_items):
                orig_desc = (orig_item.get('description') or orig_item.get('name') or '').strip().lower()
                orig_code = orig_item.get('account_code') or orig_item.get('accountCode')
                corr_code = corr_item.get('account_code') or corr_item.get('accountCode')

                # If account code was changed, create a mapping
                if orig_desc and orig_code and corr_code and orig_code != corr_code:
                    # Use normalized description as key
                    normalized_desc = ' '.join(orig_desc.split())
                    mappings[normalized_desc] = corr_code
                    print(f"📚 Learned mapping: '{normalized_desc[:50]}...' → {corr_code} (was {orig_code})", file=sys.stderr)

        print(f"📚 Extracted {len(mappings)} account code mappings from corrections", file=sys.stderr)
        return mappings

    def _get_learning_context_for_accounts(self) -> str:
        """Generate learning context string from account code mappings."""
        if not self.account_code_mappings:
            return ""

        context = "\n\nLEARNING FROM USER CORRECTIONS - Account Code Mappings:\n"
        context += "The following mappings were learned from previous user corrections:\n"

        # Show up to 10 most recent mappings
        items_shown = 0
        for desc, code in list(self.account_code_mappings.items())[:10]:
            context += f"- '{desc[:60]}...' → Account Code: {code}\n"
            items_shown += 1

        if len(self.account_code_mappings) > 10:
            context += f"... and {len(self.account_code_mappings) - 10} more mappings\n"

        context += "\nWhen you see similar line item descriptions, prefer using the account codes from these mappings.\n"
        return context

    def _get_caen_account_guidance(self) -> str:
        """Generate account code guidance based on CAEN codes."""
        if not self.primary_caen:
            return "No CAEN code available. Use standard account selection rules."

        guidance = []
        caen = str(self.primary_caen)

        if caen.startswith('47'):
            guidance.append("PRIMARY BUSINESS: RETAIL")
            guidance.append("- For OUTGOING invoices: Prefer 707 (Venituri din vânzarea mărfurilor)")
            guidance.append("- For INCOMING invoices: Prefer 607 (Cheltuieli privind mărfurile) or 371 (Mărfuri)")
        elif caen.startswith('62'):
            guidance.append("PRIMARY BUSINESS: IT/SOFTWARE SERVICES")
            guidance.append("- For OUTGOING invoices: Prefer 704 (Venituri din prestări servicii)")
            guidance.append("- For INCOMING invoices: Prefer 628 (Alte cheltuieli cu serviciile executate de terți) or 213 (Echipamente)")
        elif caen.startswith('25'):
            guidance.append("PRIMARY BUSINESS: MANUFACTURING")
            guidance.append("- For OUTGOING invoices: Prefer 701 (Venituri din vânzarea produselor)")
            guidance.append("- For INCOMING invoices: Prefer 601-609 (Cheltuieli cu materiile prime și materialele)")
        elif caen.startswith('56'):
            guidance.append("PRIMARY BUSINESS: FOOD SERVICES")
            guidance.append("- For OUTGOING invoices: Prefer 708 (Venituri din activități de hospodărie) or 707 (Venituri din vânzarea mărfurilor)")
            guidance.append("- For INCOMING invoices: Prefer 601-602 (Cheltuieli cu materiile prime și materialele consumabile)")
        elif caen.startswith('69') or caen.startswith('70') or caen.startswith('71'):
            guidance.append("PRIMARY BUSINESS: PROFESSIONAL SERVICES")
            guidance.append("- For OUTGOING invoices: Prefer 704 (Venituri din prestări servicii)")
            guidance.append("- For INCOMING invoices: Prefer 622 (Cheltuieli cu onorariile) or 628 (Alte cheltuieli cu serviciile executate de terți)")
        else:
            desc = self.primary_caen_description or 'Unknown'
            guidance.append(f"PRIMARY BUSINESS: CAEN {caen} - {desc}")
            guidance.append("- Use standard account selection rules based on invoice direction and item description")

        # Add secondary CAEN hints
        if self.secondary_caen_codes:
            guidance.append("")
            guidance.append("SECONDARY ACTIVITIES:")
            for caen_obj in self.secondary_caen_codes:
                if isinstance(caen_obj, dict):
                    code = caen_obj.get('code', '')
                    desc = caen_obj.get('description', '')
                    if desc:
                        guidance.append(f"- CAEN {code} ({desc}): Consider additional account codes for this activity")
                    else:
                        guidance.append(f"- CAEN {code}: Consider additional account codes for this activity")
                else:
                    # Fallback for string format
                    guidance.append(f"- CAEN {caen_obj}: Consider additional account codes for this activity")

        return "\n".join(guidance) if guidance else "Use standard account selection rules."

    def _format_account_preferences(self) -> str:
        """Format account code preferences for agent prompts."""
        if not self.account_preferences:
            return "No learned account code preferences yet."

        # Sort by usage count
        entries = sorted(
            self.account_preferences.items(),
            key=lambda x: x[1].get('usageCount', 0) if isinstance(x[1], dict) else 0,
            reverse=True
        )[:10]

        if not entries:
            return "No learned account code preferences yet."

        lines = ["LEARNED ACCOUNT CODE PREFERENCES (from previous corrections):"]
        for desc, data in entries:
            if isinstance(data, dict):
                account_code = data.get('accountCode', 'N/A')
                confidence = data.get('confidence', 0.7)
                usage_count = data.get('usageCount', 1)
                lines.append(
                    f'- "{desc[:60]}..." → {account_code} '
                    f'(confidence: {confidence:.2f}, used {usage_count}x)'
                )
            else:
                lines.append(f'- "{desc[:60]}..." → {data}')

        return "\n".join(lines)

    def _infer_business_type(self) -> str:
        """Infer business type from CAEN codes."""
        if not self.primary_caen:
            return "Unknown"

        caen = str(self.primary_caen)
        if caen.startswith('47'):
            return "Retail"
        elif caen.startswith('62'):
            return "IT/Software Services"
        elif caen.startswith('25'):
            return "Manufacturing"
        elif caen.startswith('56'):
            return "Food Services"
        elif caen.startswith('69') or caen.startswith('70') or caen.startswith('71'):
            return "Professional Services"
        else:
            return f"CAEN {caen}"

    def attribute_account_for_transaction(self, transaction_data: dict, romanian_chart_of_accounts: str) -> dict:
        """Use the account attribution agent to categorize a bank transaction."""
        try:
            attribution_crew = Crew(
                agents=[self.account_attribution_agent()],
                tasks=[self.attribute_bank_transaction_account_task()],
                verbose=False  # Disable verbose output to prevent formatted table output
            )

            inputs = {
                'transaction_description': transaction_data.get('description', ''),
                'transaction_amount': transaction_data.get('amount', 0),
                'transaction_currency': transaction_data.get('currency', 'RON'),
                'transaction_type': transaction_data.get('transactionType', ''),
                'reference_number': transaction_data.get('referenceNumber', ''),
                'transaction_date': transaction_data.get('transactionDate', ''),
                'romanian_chart_of_accounts': romanian_chart_of_accounts
            }

            result = attribution_crew.kickoff(inputs=inputs)

            if hasattr(result, 'tasks_output') and result.tasks_output:
                task_output = result.tasks_output[0]
                if hasattr(task_output, 'raw'):
                    return self._parse_account_attribution_result(task_output.raw)

            return {
                'account_code': '628',
                'account_name': 'Alte cheltuieli cu serviciile executate de terți',
                'confidence': 0.3,
                'reasoning': 'Could not determine specific account, using general expense account',
                'requires_manual_review': True
            }

        except Exception as e:
            print(f"Account attribution failed: {str(e)}", file=sys.stderr)
            return {
                'account_code': '628',
                'account_name': 'Alte cheltuieli cu serviciile executate de terți',
                'confidence': 0.1,
                'reasoning': f'Attribution failed due to error: {str(e)}',
                'requires_manual_review': True
            }

    def _parse_account_attribution_result(self, raw_output: str) -> dict:
        """Parse the agent's JSON output.

        The agent returns a JSON object that may contain nested objects/arrays
        (e.g. alternative_accounts) and may be wrapped in markdown code fences or
        surrounding prose. We therefore strip code fences and extract the first
        balanced-brace JSON object rather than using a flat regex, which cannot
        match nested braces and would capture an inner sub-object (or nothing).
        """
        if not raw_output:
            return {
                'account_code': '628',
                'account_name': 'Alte cheltuieli cu serviciile executate de terți',
                'confidence': 0.2,
                'reasoning': 'Empty agent response',
                'requires_manual_review': True
            }
        try:
            text = raw_output.strip()

            # Strip markdown code fences like ```json ... ``` if present.
            if text.startswith('```'):
                text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
                text = re.sub(r'\n?```\s*$', '', text).strip()

            # Fast path: the whole (de-fenced) output is valid JSON.
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                pass

            # Otherwise extract the first top-level balanced-brace object.
            candidate = self._extract_first_json_object(text)
            if candidate is not None:
                return json.loads(candidate)

            return {
                'account_code': '628',
                'account_name': 'Alte cheltuieli cu serviciile executate de terți',
                'confidence': 0.2,
                'reasoning': 'Could not parse agent response',
                'requires_manual_review': True
            }
        except Exception as e:
            print(f"Failed to parse attribution result: {str(e)}", file=sys.stderr)
            return {
                'account_code': '628',
                'account_name': 'Alte cheltuieli cu serviciile executate de terți',
                'confidence': 0.1,
                'reasoning': 'Parsing error',
                'requires_manual_review': True
            }

    @staticmethod
    def _extract_first_json_object(text: str) -> Optional[str]:
        """Return the first top-level ``{...}`` block with balanced braces.

        Braces appearing inside JSON string literals are ignored so that nested
        objects/arrays are captured correctly.
        """
        start = text.find('{')
        if start == -1:
            return None
        depth = 0
        in_string = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escape:
                    escape = False
                elif ch == '\\':
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
        return None

    @agent
    def document_categorizer(self) -> Agent:
        learning_context = ""
        if self.user_corrections:
            categorization_corrections = [c for c in self.user_corrections if c.get('correctionType') == 'DOCUMENT_TYPE']
            if categorization_corrections:
                learning_context = f"\n\nLearning from previous corrections:\n"
                for correction in categorization_corrections[-5:]:  # Use last 5 corrections
                    learning_context += f"- Original prediction: {correction.get('originalValue')}, Correct answer: {correction.get('correctedValue')}\n"

        print(f"Trying to access document_categorizer config...", file=sys.stderr)

        enhanced_goal = self.agents_config['document_categorizer']['goal'] + f" Learn from user corrections to improve accuracy.{learning_context}"
        enhanced_backstory = self.agents_config['document_categorizer']['backstory'] + " You learn from user feedback to continuously improve your classifications."

        agent_config = {
            'role': self.agents_config['document_categorizer']['role'],
            'goal': enhanced_goal,
            'backstory': enhanced_backstory,
            'verbose': False,  # Disable verbose output to prevent formatted table output
            'tools': [get_text_extractor_tool()],
        }

        if self.llm:
            agent_config['llm'] = self.llm

        print(f"Document categorizer config created successfully", file=sys.stderr)
        return Agent(**agent_config)

    @agent
    def document_extractor(self) -> Agent:
        """Single generic extractor used for every document type.

        Document-type-specific behavior comes entirely from the per-type task
        prompt (tasks.yaml); this replaces the 7 previously-identical specialist
        agents. Only used by the legacy CrewAI path — the default direct path
        calls OpenAI without CrewAI agents.
        """
        agent_config = {
            'role': self.agents_config['document_extractor']['role'],
            'goal': self.agents_config['document_extractor']['goal'],
            'backstory': self.agents_config['document_extractor']['backstory'],
            'verbose': False,
            'tools': [get_text_extractor_tool()],
        }

        if self.llm:
            agent_config['llm'] = self.llm

        agent_config['max_iter'] = 3
        agent_config['max_execution_time'] = 300

        return Agent(**agent_config)

    @agent
    def account_attribution_agent(self) -> Agent:

        # No tools: account attribution operates only on the transaction fields
        # provided in the prompt. A document text-extractor is useless here (there
        # is no document), and web search (Serper) would leak transaction
        # descriptions to a third party for negligible categorization value.
        agent_config = {
            'role': self.agents_config['account_attribution_agent']['role'],
            'goal': self.agents_config['account_attribution_agent']['goal'],
            'backstory': self.agents_config['account_attribution_agent']['backstory'],
            'verbose': False,  # Disable verbose output to prevent formatted table output
            'tools': [],
        }

        # Account attribution feeds bookkeeping records, so it runs at
        # temperature=0 for deterministic, reproducible categorization.
        if self._attribution_llm is None:
            self._attribution_llm = get_configured_llm(temperature=0)
        attribution_llm = self._attribution_llm or self.llm
        if attribution_llm:
            agent_config['llm'] = attribution_llm

        agent_config['max_iter'] = 3
        agent_config['max_execution_time'] = 300

        return Agent(**agent_config)

    def get_dynamic_prompt_suffix(self, document_type: str) -> str:
        """Dynamic per-document prompt augmentation (neplatitor TVA + learned
        corrections + CAEN business context).

        Shared by the legacy CrewAI task builders and the direct-extraction
        path so both produce identical prompts. Generic field corrections apply
        to every supported document type; the accounting-specific neplatitor,
        account-code, and CAEN blocks remain limited to Invoice/Receipt.
        """
        suffix = self._get_field_correction_context(document_type)
        if document_type not in ('Invoice', 'Receipt'):
            return suffix

        if self.is_neplatitor_tva:
            noun = document_type.lower()  # 'invoice' or 'receipt'
            suffix += (
                f"\n\nCRITICAL - NEAPLATITOR TVA (VAT NON-PAYER): This company is NOT a VAT payer. You MUST:\n"
                f"- Set vat_amount to 0 (zero) in the {noun}-level data (the overall {noun} VAT)\n"
                f"- STILL EXTRACT vat_amount for EACH line item from the document (the VAT is shown on the {noun} and needs to be extracted)\n"
                f"- STILL EXTRACT the vat rate for each line item (0%, 9%, 11%, 19%, or 21%)\n"
                f"- CRITICAL: Extract total_amount as the FULL AMOUNT WITH VAT INCLUDED (the gross total). Even though this is a neplatitor company, total_amount must always be the complete amount including VAT. If the document shows separate net and VAT amounts, calculate total_amount = net + the VAT PRINTED ON THE DOCUMENT — use the document's actual VAT here, NOT the 0 you report in the {noun}-level vat_amount field (that 0 is only how a non-VAT-payer reports it; the gross total still includes the real VAT).\n"
                f"- For line items: Extract both the net total (total) AND the VAT amount (vat_amount) separately, even though this is a neplatitor company\n"
                f"- The system will combine total + vat_amount for display and posting purposes\n"
                f"- IMPORTANT: Do NOT set line item vat_amount to 0 - extract the actual VAT shown on the {noun} for each line item"
            )

        learning_context = self._get_learning_context_for_accounts()
        if learning_context:
            suffix += learning_context

        caen_context = self._build_caen_context_section()
        if caen_context:
            suffix += "\n\n" + caen_context

        return suffix

    def _get_field_correction_context(self, document_type: str) -> str:
        """Turn recent review-UI edits into concise extraction examples.

        AutoImport stores corrections in Finova's correction envelope. Keeping
        this block generic lets vehicle documents (VIN, registration and CMR)
        participate in the same learning flywheel that Finova already uses for
        invoice account mappings.
        """
        if not self.user_corrections:
            return ""

        examples = []
        for correction in self.user_corrections:
            if correction.get('correctionType') != 'FIELD_VALUE':
                continue
            field = str(correction.get('field') or '').strip()
            corrected = correction.get('correctedValue')
            if not field or not isinstance(corrected, dict) or field not in corrected:
                continue
            original = correction.get('originalValue')
            original_value = original.get(field) if isinstance(original, dict) else None
            examples.append({
                'field': field,
                'original': original_value,
                'corrected': corrected.get(field),
            })
            if len(examples) >= 20:
                break

        if not examples:
            return ""

        return (
            "\n\nLEARNING FROM RECENT USER CORRECTIONS:\n"
            f"These are prior corrections relevant to the client's {document_type} extraction. "
            "Use them as examples when the same field or formatting pattern appears; "
            "never copy a value unless it is present in the current document.\n"
            f"{json.dumps(examples, ensure_ascii=False, default=str)}"
        )

    @task
    def categorize_document_task(self) -> Task:
        return Task(
            config=self.tasks_config['categorize_document_task'],
        )

    @task
    def extract_invoice_data_task(self) -> Task:
        task_config = self.tasks_config['extract_invoice_data_task'].copy()
        base_description = task_config.get('description') or ''
        base_description += self.get_dynamic_prompt_suffix('Invoice')
        task_config['description'] = base_description

        return Task(
            config=task_config,
            output_file='invoice_data.json'
        )

    def _build_caen_context_section(self) -> str:
        """Build CAEN context section for task descriptions."""
        if not self.primary_caen:
            return ""

        # Format secondary CAEN codes
        secondary_caen_str = 'N/A'
        if self.secondary_caen_codes:
            formatted_secondary = []
            for caen_obj in self.secondary_caen_codes:
                if isinstance(caen_obj, dict):
                    code = caen_obj.get('code', '')
                    desc = caen_obj.get('description', '')
                    if desc:
                        formatted_secondary.append(f"{code} ({desc})")
                    else:
                        formatted_secondary.append(code)
                else:
                    # Fallback for string format
                    formatted_secondary.append(str(caen_obj))
            secondary_caen_str = ', '.join(formatted_secondary) if formatted_secondary else 'N/A'

        lines = [
            "\nCLIENT COMPANY BUSINESS CONTEXT:",
            f"- Primary CAEN: {self.primary_caen} - {self.primary_caen_description or 'N/A'}",
            f"- Secondary CAEN Codes: {secondary_caen_str}",
            f"- Business Type: {self._infer_business_type()}",
            "",
            "ACCOUNT CODE ATTRIBUTION - CONSIDER BUSINESS CONTEXT:",
            "When attributing account codes, consider the client company's business activities:",
            self._get_caen_account_guidance(),
            "",
            self._format_account_preferences()
        ]

        return "\n".join(lines)

    # Specialized Tasks
    @task
    def extract_receipt_data_task(self) -> Task:
        task_config = self.tasks_config['extract_receipt_data_task'].copy()
        base_description = task_config.get('description') or ''
        base_description += self.get_dynamic_prompt_suffix('Receipt')
        task_config['description'] = base_description

        return Task(
            config=task_config,
            output_file='receipt_data.json'
        )

    @task
    def extract_bank_statement_data_task(self) -> Task:
        return Task(
            config=self.tasks_config['extract_bank_statement_data_task'],
            output_file='bank_statement_data.json'
        )

    @task
    def extract_contract_data_task(self) -> Task:
        return Task(
            config=self.tasks_config['extract_contract_data_task'],
            output_file='contract_data.json'
        )

    @task
    def extract_z_report_data_task(self) -> Task:
        return Task(
            config=self.tasks_config['extract_z_report_data_task'],
            output_file='z_report_data.json'
        )

    @task
    def extract_payment_disposition_data_task(self) -> Task:
        return Task(
            config=self.tasks_config['extract_payment_disposition_data_task'],
            output_file='payment_disposition_data.json'
        )

    @task
    def extract_collection_disposition_data_task(self) -> Task:
        return Task(
            config=self.tasks_config['extract_collection_disposition_data_task'],
            output_file='collection_disposition_data.json'
        )

    # Backward compatibility aliases
    @task
    def extract_payment_order_data_task(self) -> Task:
        return self.extract_payment_disposition_data_task()

    @task
    def extract_collection_order_data_task(self) -> Task:
        return self.extract_collection_disposition_data_task()

    @task
    def attribute_bank_transaction_account_task(self) -> Task:
        return Task(
            config=self.tasks_config['attribute_bank_transaction_account_task'],
            output_file='account_attribution.json'
        )

    @crew
    def crew(self, document_type: str = None) -> Crew:
        # Ensure document_type is properly handled
        if document_type is None:
            document_type = "Unknown"
            print(f"⚠️  No document_type provided, defaulting to 'Unknown'", file=sys.stderr)
        if self.processing_phase == 0:
            tasks = [self.categorize_document_task()]
            print("Phase 0: Only running categorization task", file=sys.stderr)
            crew_config = {
                'agents': self.agents,
                'tasks': tasks,
                'verbose': False,  # Disable verbose output to prevent formatted table output
                'process': Process.sequential
            }
        else:
            # Phase 1: Data extraction with specialized agents
            print(f"\n{'='*60}", file=sys.stderr)
            print(f"🤖 AGENT SELECTION LOGIC", file=sys.stderr)
            print(f"{'='*60}", file=sys.stderr)
            print(f"📄 Document Type: {document_type}", file=sys.stderr)
            print(f"🎯 Specialized Agents Enabled: {self.use_specialized_agents}", file=sys.stderr)
            print(f"📋 Document Type Supported: {document_type in self.document_type_agents if document_type else 'N/A'}", file=sys.stderr)

            if not document_type:
                print(f"❌ ERROR: No document type provided", file=sys.stderr)
                raise ValueError("Document type is required for processing")

            if not self.use_specialized_agents:
                print(f"❌ ERROR: Specialized agents are disabled", file=sys.stderr)
                raise ValueError("Specialized agents must be enabled")

            if document_type not in self.document_type_agents:
                print(f"❌ ERROR: Document type '{document_type}' not supported", file=sys.stderr)
                print(f"📋 Supported types: {list(self.document_type_agents.keys())}", file=sys.stderr)
                raise ValueError(f"Unsupported document type: {document_type}")

            # Use specialized agent for this document type
            specialized_agent_name = self.document_type_agents[document_type]
            specialized_task_name = self.document_type_tasks[document_type]

            print(f"🔧 Creating specialized {document_type} agent...", file=sys.stderr)

            # Get the specialized agent and task
            specialized_agent = getattr(self, specialized_agent_name)()
            specialized_task = getattr(self, specialized_task_name)()

            tasks = [specialized_task]
            agents = [specialized_agent]

            print(f"✅ SELECTED: Specialized {document_type} agent", file=sys.stderr)
            print(f"🔧 Agent: {specialized_agent_name}", file=sys.stderr)
            print(f"📝 Task: {specialized_task_name}", file=sys.stderr)
            print(f"💰 Expected: 10-15% cost reduction, 15-25% faster processing", file=sys.stderr)
            print(f"{'='*60}\n", file=sys.stderr)

            crew_config = {
                'agents': agents,
                'tasks': tasks,
                'verbose': False,  # Disable verbose output to prevent formatted table output
                'process': Process.sequential
            }

        if self.llm:
            crew_config['manager_llm'] = self.llm

        return Crew(**crew_config)
