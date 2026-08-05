import unittest
from unittest.mock import patch

import direct_extraction


class TransportMessageExtractionTests(unittest.TestCase):
    def test_pasted_message_is_extracted_and_normalized(self):
        captured = {}

        def fake_call(**kwargs):
            captured.update(kwargs)
            return (
                {
                    "transporter_name": " Fast Cargo GmbH ",
                    "transporter_tax_id": " de123456 ",
                    "transporter_country": "de",
                    "vehicle_plate": " b 123 abc ",
                    "trailer_plate": " de xy 987 ",
                    "loading_city": "Berlin",
                    "loading_country": "de",
                    "unloading_city": None,
                    "unloading_county": None,
                    "transport_date": "2026-08-06",
                },
                {},
            )

        with patch.object(direct_extraction, "_call_structured", side_effect=fake_call):
            data = direct_extraction.extract_transport_message(
                "Pickup tomorrow in Berlin. Truck B 123 ABC.",
                "2026-08-05",
            )

        self.assertEqual(data["transporter_name"], "Fast Cargo GmbH")
        self.assertEqual(data["transporter_tax_id"], "DE123456")
        self.assertEqual(data["transporter_country"], "DE")
        self.assertEqual(data["vehicle_plate"], "B 123 ABC")
        self.assertEqual(data["loading_country"], "DE")
        self.assertIn("2026-08-05", captured["messages"][1]["content"])
        self.assertIn("untrusted source data", captured["messages"][0]["content"])

    def test_empty_message_is_rejected_without_model_call(self):
        with patch.object(direct_extraction, "_call_structured") as model_call:
            with self.assertRaisesRegex(ValueError, "empty"):
                direct_extraction.extract_transport_message("  ")
        model_call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
