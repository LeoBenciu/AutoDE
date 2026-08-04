import tempfile
import unittest
from unittest.mock import patch

import direct_extraction


class ReceiptClassificationTests(unittest.TestCase):
    def test_bon_fiscal_heading_is_deterministic_receipt(self):
        with patch.object(
            direct_extraction,
            "_read_cached_document_text",
            return_value="S.C. OMV PETROM\nBON FISCAL\nTOTAL 49,91",
        ), patch.object(direct_extraction, "_call_structured") as model_call:
            data, meta = direct_extraction.categorize_document(
                "/tmp/bon.jpeg", {"client_company_ein": "31194616"}
            )

        self.assertEqual(data["document_type"], "Receipt")
        self.assertEqual(data["confidence"], 0.99)
        self.assertEqual(meta["model"], "deterministic-heading")
        model_call.assert_not_called()

    def test_photo_classification_receives_the_image_when_ocr_is_empty(self):
        captured = {}

        def fake_call(**kwargs):
            captured.update(kwargs)
            return (
                {
                    "document_type": "Receipt",
                    "direction": None,
                    "confidence": 0.95,
                    "aviz": False,
                },
                {},
            )

        with tempfile.NamedTemporaryFile(suffix=".jpeg") as image_file, patch.object(
            direct_extraction, "_read_cached_document_text", return_value=""
        ), patch.object(
            direct_extraction, "_render_doc_images", return_value=["base64-page"]
        ), patch.object(
            direct_extraction, "_call_structured", side_effect=fake_call
        ):
            data, meta = direct_extraction.categorize_document(
                image_file.name, {"client_company_ein": "31194616"}
            )

        self.assertEqual(data["document_type"], "Receipt")
        self.assertTrue(meta["vision"])
        user_content = captured["messages"][1]["content"]
        self.assertTrue(any(part.get("type") == "image_url" for part in user_content))
        self.assertIn("vision", captured["label"])


if __name__ == "__main__":
    unittest.main()
