import os
import sys
import base64
import logging
from typing import Type, Optional
from pydantic import BaseModel, Field
from crewai.tools import BaseTool

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False

try:
    from pdf2image import convert_from_path
    from PIL import Image
    import io
    PDF_TO_IMAGE_AVAILABLE = True
except ImportError:
    PDF_TO_IMAGE_AVAILABLE = False

# Opt-in debug trace (FINOVA_DEBUG_TRACE=1); a no-op singleton when disabled.
try:
    from .debug_trace import TRACE, glued_numbers_score
except ImportError:
    from debug_trace import TRACE, glued_numbers_score  # type: ignore

def _textract_mode() -> str:
    """Which Textract API to use, in precedence order:

      * ``expense`` — AnalyzeExpense (invoice/receipt summary fields + segmented
        line items), FINOVA_TEXTRACT_EXPENSE=true (off by default — LOST its A/B);
      * ``analyze`` — AnalyzeDocument (TABLES+FORMS), default ON (champion
        config) — FINOVA_TEXTRACT_ANALYZE=false to A/B;
      * ``detect``  — plain DetectDocumentText OCR (fallback).

    Expense wins if both structured flags are set; it's the purpose-built path
    for invoices/receipts. AnalyzeExpense still returns the raw OCR lines, so
    other doc types degrade gracefully rather than break."""
    if os.getenv('FINOVA_TEXTRACT_EXPENSE', 'false').lower() == 'true':
        return 'expense'
    if os.getenv('FINOVA_TEXTRACT_ANALYZE', 'true').lower() == 'true':
        return 'analyze'
    return 'detect'


def _structured_mode() -> bool:
    """AnalyzeDocument and AnalyzeExpense both need the per-page-image path (the
    sync APIs reject multi-page PDF bytes) and both benefit from lossless PNG
    (JPEG artifacts hurt small-font OCR). DetectDocumentText needs neither."""
    return _textract_mode() in ('analyze', 'expense')


def _ocr_dpi() -> int:
    """Render DPI for PDF→image conversion. Textract recommends 300 for small
    fonts (Romanian invoices print tiny); override via FINOVA_OCR_DPI."""
    try:
        return int(os.getenv('FINOVA_OCR_DPI', '300'))
    except ValueError:
        return 300


def _ocr_max_pages() -> int:
    """Hard cap on how many pages we render+OCR per PDF, to bound memory/cost on
    pathological documents. Generous by default (we stream pages one-at-a-time so
    memory no longer scales with page count); override via FINOVA_OCR_MAX_PAGES."""
    try:
        return max(1, int(os.getenv('FINOVA_OCR_MAX_PAGES', '100')))
    except ValueError:
        return 100


def _parse_analyze(response: dict) -> str:
    try:
        from textract_analyze import parse_analyze_response
    except ImportError:
        from .textract_analyze import parse_analyze_response
    return parse_analyze_response(response)


def _parse_expense(response: dict) -> str:
    try:
        from textract_expense import parse_expense_response
    except ImportError:
        from .textract_expense import parse_expense_response
    return parse_expense_response(response)


class FileReadInput(BaseModel):
    file_path: str = Field(..., description="Path to the file to extract text from")

class AWSTextractExtractor(BaseTool):
    name: str = "aws_textract_extractor"
    description: str = "Extract text from documents using AWS Textract (cost-effective and fast)"
    args_schema: Type[BaseModel] = FileReadInput

    def __init__(self):
        super().__init__()
        if not BOTO3_AVAILABLE:
            logging.warning("boto3 not available - AWS Textract will not work")

    def _run(self, file_path: str, max_pages: Optional[int] = None) -> str:
        """Extract text from a document using AWS Textract.

        max_pages overrides the default FINOVA_OCR_MAX_PAGES cap for this call —
        callers with a wall-clock budget (e.g. long bank statements that must OCR
        within the Phase-1 timeout) pass a smaller cap so the per-page loop can't
        run past the process timeout and get SIGKILLed.
        """
        if not BOTO3_AVAILABLE:
            return "ERROR: boto3 not installed. Install with: pip install boto3"

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        try:
            # Check file extension
            if file_path.lower().endswith('.pdf'):
                return self._extract_from_pdf(file_path, max_pages=max_pages)
            elif file_path.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.bmp')):
                return self._extract_from_image(file_path)
            else:
                return f"ERROR: Unsupported file type. AWS Textract supports PDF and image files."
        except Exception as e:
            logging.error(f"AWS Textract extraction failed: {str(e)}")
            return f"ERROR: Textract extraction failed - {str(e)}"

    def _extract_from_pdf(self, file_path: str, max_pages: Optional[int] = None) -> str:
        """Extract text from PDF using AWS Textract"""
        sys.stderr.write(f"📄 Starting AWS Textract extraction for PDF: {os.path.basename(file_path)}\n")
        sys.stderr.flush()

        try:
            # Initialize Textract client
            textract = boto3.client(
                'textract',
                region_name=os.getenv('AWS_REGION', 'us-east-1'),
                aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
                aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
            )

            # The structured APIs (AnalyzeDocument / AnalyzeExpense) are sync-only
            # and don't accept multi-page PDF bytes, so when either is enabled we
            # render each page to an image and analyze it individually.
            if _structured_mode():
                sys.stderr.write(f"🔎 Textract structured mode ({_textract_mode()}) — per-page image path\n")
                sys.stderr.flush()
                return self._extract_pdf_via_image(file_path, textract, max_pages=max_pages)

            # For multi-page PDFs, we need to convert to images or use async API
            # Textract detect_document_text can handle multi-page PDFs up to 5MB
            file_size = os.path.getsize(file_path)

            # Textract has a 5MB limit for synchronous calls
            if file_size > 5 * 1024 * 1024:
                sys.stderr.write(f"⚠️  PDF file too large ({file_size / (1024*1024):.2f}MB), processing all pages via image conversion\n")
                sys.stderr.flush()
                return self._extract_pdf_via_image(file_path, textract, max_pages=max_pages)

            # Read PDF file
            with open(file_path, 'rb') as document:
                document_bytes = document.read()

            sys.stderr.write(f"🔄 Calling AWS Textract API...\n")
            sys.stderr.flush()

            # Call Textract
            response = textract.detect_document_text(
                Document={'Bytes': document_bytes}
            )

            # Extract text from response
            extracted_text = self._parse_textract_response(response)

            # Count pages from response
            pages = set()
            for block in response.get('Blocks', []):
                if 'Page' in block:
                    pages.add(block['Page'])
            num_pages = len(pages) if pages else 1

            sys.stderr.write(f"✅ AWS Textract extracted {len(extracted_text)} characters from {num_pages} page(s)\n")
            sys.stderr.write(f"💰 COST: ~${(num_pages * 0.0015):.4f} ({num_pages} pages × $0.0015 per page)\n")
            sys.stderr.flush()

            if TRACE.enabled:
                try:
                    TRACE.stage(
                        "ocr_textract",
                        mode=_textract_mode(),
                        char_count=len(extracted_text or ""),
                        glued_numbers=glued_numbers_score(extracted_text or ""),
                        has_page_markers=("=== PAGE" in (extracted_text or "")),
                        sample=TRACE.sample(extracted_text),
                    )
                except Exception:
                    pass

            return extracted_text

        except ClientError as e:
            error_code = e.response['Error']['Code']
            error_message = e.response['Error']['Message']
            sys.stderr.write(f"❌ AWS Textract API error: {error_code} - {error_message}\n")
            sys.stderr.flush()

            if error_code == 'InvalidParameterException':
                # File might be too large or multi-page, try image conversion
                sys.stderr.write(f"🔄 Trying image-based extraction...\n")
                sys.stderr.flush()
                return self._extract_pdf_via_image(file_path, textract, max_pages=max_pages)

            return f"ERROR: AWS Textract failed - {error_message}"
        except Exception as e:
            sys.stderr.write(f"❌ Unexpected error: {str(e)}\n")
            sys.stderr.flush()
            return f"ERROR: {str(e)}"

    def _extract_pdf_via_image(self, file_path: str, textract_client, max_pages: Optional[int] = None) -> str:
        """Extract text from PDF by converting to images first.

        Pages are rendered to a temp dir on DISK and processed one at a time, so
        only a single page image is ever resident in memory. Rendering *every*
        page of a long PDF into one in-memory list at 300 DPI (~26 MB/page
        decoded) is what OOM-killed the 2 GB container — and the structured bank
        path forces this code path for every (potentially 30+ page) statement.
        """
        if not PDF_TO_IMAGE_AVAILABLE:
            return "ERROR: pdf2image not available. Install with: pip install pdf2image pillow"

        import tempfile

        sys.stderr.write(f"🔄 Converting PDF to images for Textract processing...\n")
        sys.stderr.flush()

        # Auto-orient each rendered page upright before OCR: scanned PDFs
        # (e.g. an HP MFP scan with a /Rotate flag poppler applies to a
        # still-sideways image) otherwise reach Textract rotated, wrecking
        # table detection and OCR. Best-effort — no-ops if unavailable.
        try:
            from .image_orient import auto_orient
        except ImportError:
            try:
                from image_orient import auto_orient  # type: ignore
            except ImportError:
                auto_orient = lambda im: im  # noqa: E731

        dpi = _ocr_dpi()
        # A caller-supplied cap (e.g. a bank statement that must OCR within the
        # Phase-1 process timeout) takes precedence over the generous global cap,
        # bounded so it can never exceed it.
        global_cap = _ocr_max_pages()
        max_pages = min(global_cap, max_pages) if max_pages else global_cap

        try:
            with tempfile.TemporaryDirectory(prefix="finova_ocr_") as tmpdir:
                # paths_only=True writes each page to disk and returns file paths
                # instead of decoded PIL images, so peak RAM is one page (not N).
                # last_page caps pathological PDFs (memory is already bounded by
                # streaming; this just bounds OCR cost/time).
                image_paths = convert_from_path(
                    file_path, dpi=dpi, fmt='png', output_folder=tmpdir,
                    paths_only=True, first_page=1, last_page=max_pages,
                )
                if not image_paths:
                    return "ERROR: Could not convert PDF to image"

                sys.stderr.write(
                    f"📄 Rendered PDF to {len(image_paths)} page(s) at {dpi} DPI "
                    f"(streamed one-at-a-time, cap={max_pages})\n"
                )
                sys.stderr.flush()

                all_text = ""
                for i, img_path in enumerate(image_paths):
                    sys.stderr.write(f"📄 Processing page {i + 1} with Textract...\n")
                    sys.stderr.flush()

                    # Open → orient → encode one page, then release it before the
                    # next page is touched.
                    with Image.open(img_path) as opened:
                        image = auto_orient(opened)

                        # Lossless PNG for the structured paths (JPEG artifacts
                        # hurt small-font OCR); JPEG keeps the legacy
                        # DetectDocumentText path byte-compatible.
                        img_byte_arr = io.BytesIO()
                        if _structured_mode():
                            if image.mode not in ('RGB', 'L'):
                                image = image.convert('RGB')
                            image.save(img_byte_arr, format='PNG')
                        else:
                            if image.mode in ('RGBA', 'LA', 'P'):
                                image = image.convert('RGB')
                            image.save(img_byte_arr, format='JPEG', quality=95)
                        img_bytes = img_byte_arr.getvalue()

                    # Drop the rendered page from disk as soon as it's encoded.
                    try:
                        os.remove(img_path)
                    except OSError:
                        pass

                    page_text = self._textract_extract_bytes(textract_client, img_bytes)
                    all_text += f"=== PAGE {i + 1} ===\n{page_text}\n\n"

                num_pages = len(image_paths)

            sys.stderr.write(f"✅ Extracted {len(all_text)} characters from {num_pages} page(s)\n")
            # DEBUG: Verify page markers
            page_marker_count = all_text.count("=== PAGE")
            sys.stderr.write(f"🔍 [DEBUG] Page markers in AWS Textract output: {page_marker_count} (expected: {num_pages})\n")
            sys.stderr.flush()

            if TRACE.enabled:
                try:
                    TRACE.stage(
                        "ocr_textract",
                        mode=_textract_mode(),
                        char_count=len(all_text or ""),
                        glued_numbers=glued_numbers_score(all_text or ""),
                        has_page_markers=("=== PAGE" in (all_text or "")),
                        sample=TRACE.sample(all_text),
                    )
                except Exception:
                    pass

            return all_text

        except Exception as e:
            sys.stderr.write(f"❌ PDF to image extraction failed: {str(e)}\n")
            sys.stderr.flush()
            return f"ERROR: {str(e)}"

    def _extract_from_image(self, file_path: str) -> str:
        """Extract text from image file using AWS Textract"""
        sys.stderr.write(f"🖼️  Starting AWS Textract extraction for image: {os.path.basename(file_path)}\n")
        sys.stderr.flush()

        try:
            # Initialize Textract client
            textract = boto3.client(
                'textract',
                region_name=os.getenv('AWS_REGION', 'us-east-1'),
                aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
                aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
            )

            # Read image file
            with open(file_path, 'rb') as document:
                document_bytes = document.read()

            sys.stderr.write(f"🔄 Calling AWS Textract API...\n")
            sys.stderr.flush()

            # Call Textract (analyze TABLES+FORMS or plain detect, per config)
            extracted_text = self._textract_extract_bytes(textract, document_bytes)

            sys.stderr.write(f"✅ AWS Textract extracted {len(extracted_text)} characters\n")
            sys.stderr.flush()

            return extracted_text

        except ClientError as e:
            error_code = e.response['Error']['Code']
            error_message = e.response['Error']['Message']
            sys.stderr.write(f"❌ AWS Textract API error: {error_code} - {error_message}\n")
            sys.stderr.flush()
            return f"ERROR: AWS Textract failed - {error_message}"
        except Exception as e:
            sys.stderr.write(f"❌ Unexpected error: {str(e)}\n")
            sys.stderr.flush()
            return f"ERROR: {str(e)}"

    def _textract_extract_bytes(self, textract_client, image_bytes: bytes) -> str:
        """Run the configured Textract API on a single page's bytes.

        expense  → AnalyzeExpense (summary fields + segmented line items) for
                   invoices/receipts, plus the raw OCR lines;
        analyze  → AnalyzeDocument(TABLES, FORMS) rendered to text+tables+forms;
        detect   → DetectDocumentText (LINE blocks only).

        Used for image and per-page-image extraction so all modes share one code
        path.
        """
        mode = _textract_mode()
        if mode == 'expense':
            response = textract_client.analyze_expense(
                Document={'Bytes': image_bytes},
            )
            return _parse_expense(response)
        if mode == 'analyze':
            response = textract_client.analyze_document(
                Document={'Bytes': image_bytes},
                FeatureTypes=['TABLES', 'FORMS'],
            )
            return _parse_analyze(response)
        response = textract_client.detect_document_text(
            Document={'Bytes': image_bytes}
        )
        return self._parse_textract_response(response)

    def _parse_textract_response(self, response: dict) -> str:
        """Parse Textract response and extract text maintaining structure"""
        blocks = response.get('Blocks', [])

        # Extract LINE blocks to preserve document structure
        # Group by page to maintain multi-page structure
        pages = {}
        for block in blocks:
            if block['BlockType'] == 'LINE':
                text = block.get('Text', '')
                if text:
                    page_num = block.get('Page', 1)
                    if page_num not in pages:
                        pages[page_num] = []
                    pages[page_num].append(text)

        # Combine pages with clear separators
        if len(pages) > 1:
            # Multi-page document - add page separators
            extracted_text = ''
            for page_num in sorted(pages.keys()):
                if extracted_text:
                    extracted_text += f'\n\n=== PAGE {page_num} ===\n\n'
                extracted_text += '\n'.join(pages[page_num])
        else:
            # Single page - just join lines
            extracted_text = '\n'.join(pages.get(1, []))

        return extracted_text


def extract_text_with_textract(file_path: str) -> str:
    """
    Standalone function to extract text using AWS Textract.
    Can be used directly without the tool wrapper.
    """
    tool = AWSTextractExtractor()
    return tool._run(file_path)
