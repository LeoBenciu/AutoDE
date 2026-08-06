import tempfile
import unittest
from unittest.mock import patch

import direct_extraction
import validators


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

    def test_receipt_party_cuis_follow_header_and_client_labels(self):
        data = {
            "vendor_ein": "RO31194616",
            "buyer_ein": "RO31194616",
            "direction": "incoming",
        }
        text = """S.C. OMV PETROM MARKETING S.R.L.
STR. SIBIU, NR. 5A, SECTOR 6, BUCURESTI
C.I.F.: RO11201891

BON FISCAL
C.I.F.: RO31194616
Client C.U.I./C.I.F.: RO31194616
Nume Client: B.R.T COMPANY GROUP SRL
"""

        validators.reconcile_receipt_party_eins(data, text, "31194616")

        self.assertEqual(data["vendor_ein"], "11201891")
        self.assertEqual(data["buyer_ein"], "31194616")
        self.assertEqual(data["direction"], "incoming")

    def test_receipt_party_cui_recovers_common_thermal_ocr_glyphs(self):
        data = {
            "vendor_ein": "31194616",
            "buyer_ein": "31194616",
        }
        text = """S.C. OMV PETROM MARKETING S.R.L.
C.I.F.: R0112O189I
BON FISCAL
Client C.U.I./C.I.F.: RO31194616
"""

        validators.reconcile_receipt_party_eins(data, text, "31194616")

        self.assertEqual(data["vendor_ein"], "11201891")
        self.assertEqual(data["buyer_ein"], "31194616")
        self.assertEqual(data["direction"], "incoming")

    def test_fuel_receipt_buyer_defaults_to_tenant_when_not_printed(self):
        # A real OMV fuel bon fiscal prints only the seller's CUIs; the buyer's CUI
        # is nowhere on the paper, so the model duplicates the seller CUI into both
        # fields. The tenant is the buyer of an incoming purchase.
        data = {
            "vendor_ein": "RO31194616",
            "buyer_ein": "RO31194616",
        }
        text = """S.C. OMV PETROM MARKETING S.R.L.
PETROM DRUMUL TABEREI
STR. SIBIU, NR. 5A, SECTOR 6, BUCURESTI
C.I.F.: RO11201891

BON FISCAL
C.I.F.: RO31194616
Numar POS: 1
"""
        # Tenant CUI is a *different* company, not printed on the receipt.
        validators.reconcile_receipt_party_eins(data, text, "12345674")

        self.assertEqual(data["vendor_ein"], "11201891")
        self.assertEqual(data["buyer_ein"], "12345674")
        self.assertEqual(data["direction"], "incoming")

    def test_receipt_vendor_recovered_when_only_seller_cui_is_legible(self):
        # Header CIF didn't OCR; only the seller CUI below BON FISCAL survived. It is
        # the sole printed CUI that isn't the tenant, so it's the vendor, and the
        # tenant is the buyer.
        data = {
            "vendor_ein": "31194616",
            "buyer_ein": "31194616",
        }
        text = """BON FISCAL
C.I.F.: RO31194616
"""
        validators.reconcile_receipt_party_eins(data, text, "12345674")

        self.assertEqual(data["vendor_ein"], "31194616")
        self.assertEqual(data["buyer_ein"], "12345674")
        self.assertEqual(data["direction"], "incoming")

    def test_fuel_receipt_is_always_6022_without_inferred_vehicle_cost(self):
        data = {
            "line_items": [
                {
                    "name": "Benzina Standard 95",
                    "account_code": "628",
                    "vat_deductibility": "FULL",
                    "vehicle_cost_category": "OTHER",
                }
            ]
        }

        validators.enforce_receipt_line_accounts(data)

        item = data["line_items"][0]
        self.assertEqual(item["account_code"], "6022")
        self.assertEqual(item["vat_deductibility"], "PARTIAL_50")
        self.assertIsNone(item["vehicle_cost_category"])

    def test_duplicate_vendor_and_buyer_cui_fails_validation(self):
        result = validators.validate_extraction(
            "Receipt",
            {"vendor_ein": "31194616", "buyer_ein": "31194616"},
        )

        failed_rules = {
            check["rule"] for check in result["checks"] if not check["passed"]
        }
        self.assertIn("vendor CUI differs from buyer CUI", failed_rules)
        self.assertIn("buyer CUI differs from vendor CUI", failed_rules)

    def test_duplicate_party_rules_trigger_scoped_visual_repair(self):
        scoped = direct_extraction._scoped_failed(
            [
                {"rule": "vendor CUI differs from buyer CUI"},
                {"rule": "buyer CUI differs from vendor CUI"},
            ]
        )

        self.assertEqual(len(scoped), 2)

    def test_duplicate_party_repair_forces_vision_and_changes_only_identity(self):
        original = {
            "vendor": "OMV PETROM MARKETING SRL",
            "vendor_ein": "31194616",
            "buyer": "B.R.T COMPANY GROUP SRL",
            "buyer_ein": "31194616",
            "direction": "incoming",
            "document_date": "30-07-2026",
            "total_amount": 49.91,
        }
        model_repair = {
            **original,
            "vendor_ein": "11201891",
            "total_amount": 999.99,
        }
        with patch.object(
            direct_extraction,
            "_run_repair",
            return_value=(model_repair, {"model": "test"}),
        ) as repair_call:
            repaired, meta = direct_extraction._maybe_repair(
                "/tmp/bon.jpeg",
                "Receipt",
                "prompt",
                "",
                "bon.jpeg",
                original,
                {"vision": False},
                None,
                "31194616",
            )

        self.assertTrue(repair_call.call_args.kwargs["use_vision"])
        self.assertEqual(repaired["vendor_ein"], "11201891")
        self.assertEqual(repaired["buyer_ein"], "31194616")
        self.assertEqual(repaired["total_amount"], 49.91)
        self.assertTrue(meta["receipt_parties_repaired"])


if __name__ == "__main__":
    unittest.main()
