import unittest

from direct_extraction import _detect_reverse_charge


class ReverseChargeDetectionTest(unittest.TestCase):
    def test_auto1_vat_key_m_overrides_incorrect_model_true(self) -> None:
        text = """
        # Bezeichnung Bestandsnr. MwSt. Kennz. Preis €
          Description Stock ID VAT Key Price €
        001 Fahrzeug Car KL94218 M 7.208,00
        Total netto EUR 7.208,00
        """

        self.assertFalse(_detect_reverse_charge(text, {"reverse_charge": True}))

    def test_auto1_vat_key_i_sets_reverse_charge(self) -> None:
        text = """
        # Bezeichnung Bestandsnr. MwSt. Kennz. Preis €
          Description Stock ID VAT Key Price €
        001 Handling Fahrzeugdokumente KL94218 I 159,00
        002 Fahrzeug Handling KL94218 I 299,00
        Total netto EUR 835,00
        """

        self.assertTrue(_detect_reverse_charge(text, {"reverse_charge": False}))

    def test_auto1_vat_key_e_sets_reverse_charge(self) -> None:
        text = """
        # Bezeichnung Bestandsnr. MwSt. Kennz. Preis €
          Description Stock ID VAT Key Price €
        001 Fahrzeug Handling KL94218 E 299,00
        Total netto EUR 299,00
        """

        self.assertTrue(_detect_reverse_charge(text, {"reverse_charge": False}))

    def test_vat_key_cell_may_be_on_its_own_ocr_line(self) -> None:
        text = """
        MwSt. Kennz.
        VAT Key
        Preis €
        001
        Handling Fahrzeugdokumente
        KL94218
        I
        159,00
        Total netto EUR
        """

        self.assertTrue(_detect_reverse_charge(text, {}))

    def test_explicit_vat_key_m_wins_over_generic_marker(self) -> None:
        text = """
        MwSt. Kennz. / VAT Key
        001 Fahrzeug KL94218 M 7.208,00
        Reverse charge applies
        """

        self.assertFalse(_detect_reverse_charge(text, {}))

    def test_unrelated_standalone_i_without_vat_key_header_is_ignored(self) -> None:
        text = "Invoice section I\nNo VAT table is present"

        self.assertFalse(_detect_reverse_charge(text, {"reverse_charge": False}))

    def test_vat_key_m_trailing_row_with_wrapped_price_and_legend(self) -> None:
        # French AUTO1 layout where OCR leaves the key trailing its row and wraps
        # the price to the next line; the I/E legend must not flip M to True.
        text = """
        Numéro de référence Code TVA Prix EUR
        Stock ID VAT Key PriceEUR
        FS10577 M
        9.382,50
        Alfa Romeo / Giulia 2.2 JTDM Super
        M = Régime de la marge / Margin scheme
        I = Livraison intracommunautaire - Reverse charge applies
        """

        self.assertFalse(_detect_reverse_charge(text, {"reverse_charge": True}))

    def test_vat_key_i_trailing_row_still_reverse_charge(self) -> None:
        text = """
        Stock ID VAT Key PriceEUR
        KL94218 I
        299,00
        """

        self.assertTrue(_detect_reverse_charge(text, {"reverse_charge": False}))

    def test_reverse_charge_legend_alone_does_not_flip_margin_invoice(self) -> None:
        # A VAT-key table is present and reads M; a "reverse charge" legend line
        # elsewhere must not override it via the generic text marker.
        text = """
        MwSt. Kennz. / VAT Key
        FS10577 M 9.382,50
        Intra-community deliveries are subject to reverse charge.
        """

        self.assertFalse(_detect_reverse_charge(text, {"reverse_charge": True}))


if __name__ == "__main__":
    unittest.main()
