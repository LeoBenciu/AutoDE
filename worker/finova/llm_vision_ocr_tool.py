import os
import tempfile
import logging
import base64
from typing import Type, Optional, Any
from pydantic import BaseModel, Field
from crewai.tools import BaseTool

try:
    import PyPDF2
    PYPDF2_AVAILABLE = True
except ImportError:
    PYPDF2_AVAILABLE = False

try:
    from pdf2image import convert_from_path
    from PIL import Image
    import io
    PDF_TO_IMAGE_AVAILABLE = True
except ImportError:
    PDF_TO_IMAGE_AVAILABLE = False

try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False

# Opt-in debug trace (FINOVA_DEBUG_TRACE=1); a no-op singleton when disabled.
from debug_trace import TRACE, glued_numbers_score

class FileReadInput(BaseModel):
    file_path: str = Field(..., description="Path to the file to read")

class LLMVisionTextExtractorTool(BaseTool):
    name: str = "llm_vision_text_extractor"
    description: str = "Advanced text extraction using AWS Textract for Romanian documents"
    args_schema: Type[BaseModel] = FileReadInput
    textract_client: Optional[Any] = Field(None, description="AWS Textract client instance")
    textract_available: bool = Field(False, description="Whether AWS Textract is available")

    def __init__(self):
        super().__init__()
        if BOTO3_AVAILABLE:
            try:
                self.textract_client = boto3.client(
                    'textract',
                    region_name=os.getenv('AWS_REGION', 'us-east-1'),
                    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
                    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
                )
                self.textract_available = True
                logging.info("AWS Textract OCR initialized")
            except Exception as e:
                self.textract_client = None
                self.textract_available = False
                logging.warning(f"AWS Textract initialization failed: {str(e)}")
        else:
            self.textract_client = None
            self.textract_available = False
            logging.warning("AWS Textract not available - boto3 not installed")

    def _run(self, file_path: str) -> str:
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        if file_path.endswith(".pdf"):
            return self._extract_from_pdf(file_path)
        elif file_path.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.bmp')):
            if self.textract_available:
                return self._extract_from_image(file_path)
            else:
                return "Image file detected but AWS Textract not available"
        else:
            return self._extract_from_text_file(file_path)

    def _extract_from_pdf(self, file_path: str) -> str:
        logging.info(f"Starting PDF text extraction for: {file_path}")

        if PYPDF2_AVAILABLE:
            try:
                direct_text = self._extract_direct_text(file_path)
                if len(direct_text.strip()) > 100:
                    logging.info("Direct text extraction successful")
                    return direct_text
            except Exception as e:
                logging.info(f"Direct text extraction failed: {str(e)}")

        if self.textract_available:
            try:
                return self._extract_with_textract(file_path)
            except Exception as e:
                logging.error(f"AWS Textract OCR failed: {str(e)}")
                return self._extract_direct_text_fallback(file_path)
        else:
            logging.warning("AWS Textract not available, using basic PDF extraction")
            return self._extract_direct_text_fallback(file_path)

    def _extract_direct_text(self, file_path: str) -> str:
        """Extract text directly from PDF if it contains selectable text"""
        with open(file_path, 'rb') as file:
            pdf_reader = PyPDF2.PdfReader(file)
            text = ""
            for page_num, page in enumerate(pdf_reader.pages):
                page_text = page.extract_text()
                if page_text:
                    text += f"Page {page_num + 1}:\n{page_text}\n\n"
            if TRACE.enabled:
                try:
                    TRACE.stage(
                        "ocr_pypdf",
                        char_count=len(text or ""),
                        glued_numbers=glued_numbers_score(text or ""),
                        sample=TRACE.sample(text),
                    )
                except Exception:
                    pass
            return text

    def _extract_direct_text_fallback(self, file_path: str) -> str:
        """Fallback PDF text extraction"""
        try:
            return self._extract_direct_text(file_path)
        except Exception as e:
            logging.error(f"PDF text extraction failed: {str(e)}")
            return "Could not extract text from PDF. This may be an image-based PDF that requires OCR."

    def _extract_with_textract(self, file_path: str) -> str:
        """Extract text using AWS Textract"""
        logging.info("Starting AWS Textract OCR extraction")

        try:
            # Read the PDF file
            with open(file_path, 'rb') as document:
                document_bytes = document.read()

            file_size = len(document_bytes)

            # Textract has a 5MB limit for synchronous calls
            if file_size > 5 * 1024 * 1024:
                logging.info(f"PDF file too large ({file_size / (1024*1024):.2f}MB), using image-based extraction")
                return self._extract_pdf_via_textract_images(file_path)

            # Call Textract
            response = self.textract_client.detect_document_text(
                Document={'Bytes': document_bytes}
            )

            # Extract text from response
            extracted_text = self._parse_textract_response(response)
            logging.info(f"Successfully extracted {len(extracted_text)} characters using AWS Textract")

            return extracted_text

        except ClientError as e:
            error_code = e.response['Error']['Code']
            error_message = e.response['Error']['Message']
            logging.error(f"AWS Textract API error: {error_code} - {error_message}")

            if error_code == 'InvalidParameterException' and PDF_TO_IMAGE_AVAILABLE:
                # Try image-based extraction
                return self._extract_pdf_via_textract_images(file_path)

            raise
        except Exception as e:
            logging.error(f"Unexpected error in Textract extraction: {str(e)}")
            raise

    def _extract_pdf_via_textract_images(self, file_path: str) -> str:
        """Extract text from PDF by converting to images first.

        Pages are rendered to disk and processed one at a time so peak memory is a
        single page, not the whole document — rendering every page of a long PDF
        into one in-memory list is what OOM-killed the 2 GB container.
        """
        if not PDF_TO_IMAGE_AVAILABLE:
            return "Could not extract text - pdf2image not available"

        import tempfile

        try:
            max_pages = max(1, int(os.getenv('FINOVA_OCR_MAX_PAGES', '100')))
        except ValueError:
            max_pages = 100

        logging.info("Converting PDF to images for Textract processing")
        all_text = ""
        with tempfile.TemporaryDirectory(prefix="finova_ocr_") as tmpdir:
            # paths_only=True keeps the rendered pages on disk (one PIL image in
            # RAM at a time) instead of returning N decoded images at once.
            image_paths = convert_from_path(
                file_path, dpi=200, fmt='PNG', output_folder=tmpdir,
                paths_only=True, first_page=1, last_page=max_pages,
            )
            logging.info(f"Converted PDF to {len(image_paths)} images")
            if TRACE.enabled:
                try:
                    TRACE.stage("ocr_vision_render", dpi=200, pages=len(image_paths))
                except Exception:
                    pass

            for i, img_path in enumerate(image_paths):
                logging.info(f"Processing page {i + 1}/{len(image_paths)} with AWS Textract")
                with Image.open(img_path) as image:
                    page_text = self._extract_text_from_image_with_textract(image, i + 1)
                try:
                    os.remove(img_path)
                except OSError:
                    pass
                if page_text.strip():
                    all_text += f"=== PAGE {i + 1} ===\n{page_text}\n\n"

        if not all_text.strip():
            return "No text could be extracted from this document using AWS Textract."

        return all_text

    def _extract_from_image(self, file_path: str) -> str:
        """Extract text from image file using AWS Textract"""
        with Image.open(file_path) as image:
            return self._extract_text_from_image_with_textract(image, 1)

    def _extract_text_from_image_with_textract(self, image: Image.Image, page_num: int) -> str:
        """Use AWS Textract to extract text from image"""
        if not self.textract_available or not self.textract_client:
            return f"[TEXTRACT_UNAVAILABLE: Page {page_num}]"

        try:
            buffer = io.BytesIO()
            if image.mode in ('RGBA', 'LA', 'P'):
                image = image.convert('RGB')
            image.save(buffer, format='JPEG', quality=95)
            image_bytes = buffer.getvalue()

            # Call Textract
            response = self.textract_client.detect_document_text(
                Document={'Bytes': image_bytes}
            )

            extracted_text = self._parse_textract_response(response)
            logging.info(f"Successfully extracted text from page {page_num} using AWS Textract")
            return extracted_text

        except Exception as e:
            logging.error(f"AWS Textract OCR failed for page {page_num}: {str(e)}")
            return f"[OCR_ERROR: Failed to extract text from page {page_num} - {str(e)}]"

    def _parse_textract_response(self, response: dict) -> str:
        """Parse Textract response and extract text maintaining structure"""
        blocks = response.get('Blocks', [])

        # Extract LINE blocks to preserve document structure
        lines = []
        for block in blocks:
            if block['BlockType'] == 'LINE':
                text = block.get('Text', '')
                if text:
                    lines.append(text)

        # Join lines with newlines
        extracted_text = '\n'.join(lines)

        return extracted_text

    def _extract_from_text_file(self, file_path: str) -> str:
        """Extract text from plain text files"""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return f.read()
        except UnicodeDecodeError:
            with open(file_path, "r", encoding="latin-1") as f:
                return f.read()