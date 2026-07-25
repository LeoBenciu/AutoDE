"""
Pydantic schemas for OpenAI structured outputs (response_format=json_schema, strict=True).

Strict mode requires:
- every field required (use Optional[...] for nullable, no defaults)
- additionalProperties: false on every object (achieved via StrictBase below)
- enums via Literal[...]

These schemas replace prompt-only "Output as JSON" instructions plus the regex
JSON parser in main.py. The shape mirrors what downstream consumers
(controller, prisma, UI) already expect — do not rename fields without
updating those consumers.
"""

from typing import List, Optional
from typing_extensions import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictBase(BaseModel):
    """Base model: forbids extras so generated JSON schema has additionalProperties: false."""
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Enums (kept in sync with main.py inputs)
# ---------------------------------------------------------------------------

DocumentType = Literal[
    "Invoice",
    "Receipt",
    "Bank Statement",
    "Contract",
    "Z Report",
    "Payment Disposition",
    "Collection Disposition",
    "CMR",
    "Customs Declaration",
    "Vehicle Registration Certificate",
    "Technical Inspection (ITP)",
    "Insurance",
    "Other",
]

Direction = Literal["incoming", "outgoing"]

Currency = Literal[
    "RON", "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD",
    "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "BGN",
]

VatRate = Literal["ZERO", "FIVE", "NINE", "ELEVEN", "NINETEEN", "TWENTYONE"]

VatDeductibility = Literal["FULL", "PARTIAL_50", "NONE"]

UnitOfMeasure = Literal[
    "BUCATA", "KILOGRAM", "LITRU", "METRU", "GRAM", "CUTIE", "PACHET",
    "PUNGA", "SET", "METRU_PATRAT", "METRU_CUB", "MILIMETRU", "CENTIMETRU",
    "TONA", "PERECHE", "SAC", "MILILITRU", "KILOWATT_ORA", "MINUT", "ORA",
    "ZI_DE_LUCRU", "LUNI_DE_LUCRU", "DOZA", "UNITATE_DE_SERVICE",
    "O_MIE_DE_BUCATI", "TRIMESTRU", "PROCENT", "KILOMETRU", "LADA",
    "DRY_TONE", "CENTIMETRU_PATRAT", "MEGAWATI_ORA", "ROLA", "TAMBUR",
    "SAC_PLASTIC", "PALET_LEMN", "UNITATE", "TONA_NETA",
    "HECTOMETRU_PATRAT", "FOAIE",
]

ReceiptType = Literal["payment_receipt", "independent_receipt"]
PaymentMethod = Literal["cash", "bank"]


# ---------------------------------------------------------------------------
# Phase 0: Categorization
# ---------------------------------------------------------------------------

class CategorizationResult(StrictBase):
    document_type: DocumentType
    direction: Optional[Direction]  # null for non-invoice docs
    confidence: float = Field(ge=0.0, le=1.0)
    aviz: bool  # true only for Aviz de însoțire (delivery note classified as Invoice)


# ---------------------------------------------------------------------------
# Batch-scan segmentation (pre-phase-0): group a multi-page PDF's pages into
# logical documents. doc_type_hint is advisory only — each child still runs
# the real Phase 0 categorizer, so "Unknown" is allowed here.
# ---------------------------------------------------------------------------

SegmentDocTypeHint = Literal[
    "Invoice",
    "Receipt",
    "Bank Statement",
    "Contract",
    "Z Report",
    "Payment Disposition",
    "Collection Disposition",
    "CMR",
    "Customs Declaration",
    "Vehicle Registration Certificate",
    "Technical Inspection (ITP)",
    "Insurance",
    "Unknown",
]


class DocumentSegment(StrictBase):
    start_page: int  # 1-based, inclusive
    end_page: int    # 1-based, inclusive
    doc_type_hint: SegmentDocTypeHint
    confidence: float = Field(ge=0.0, le=1.0)  # confidence this is a SEPARATE document


class SegmentationResult(StrictBase):
    total_pages: int  # model echoes the page count — cheap self-consistency check
    segments: List[DocumentSegment]


# ---------------------------------------------------------------------------
# Phase 1: line item shared by Invoice and Receipt
# ---------------------------------------------------------------------------

class LineItem(StrictBase):
    name: str
    quantity: float
    unit_price: float
    total: float
    vat_amount: float
    vat: VatRate
    um: UnitOfMeasure
    articleCode: str  # empty string when no match and type is 'Nedefinit'
    account_code: str
    management: Optional[str]  # null when type is 'Nedefinit'
    isNew: bool
    vat_deductibility: Optional[VatDeductibility]  # only set for incoming docs


# ---------------------------------------------------------------------------
# Per-field self-reported confidences (task 7 will replace with deterministic
# validators; for now we keep the structure so downstream consumers don't break)
# ---------------------------------------------------------------------------

class InvoiceConfidence(StrictBase):
    document_number: float
    document_date: float
    due_date: float
    vendor: float
    vendor_ein: float
    buyer: float
    buyer_ein: float
    total_amount: float
    vat_amount: float
    currency: float


class ReceiptConfidence(StrictBase):
    receipt_number: float
    document_date: float
    vendor: float
    vendor_ein: float
    buyer: float
    buyer_ein: float
    total_amount: float
    vat_amount: float
    payment_method: float
    currency: float


# ---------------------------------------------------------------------------
# Phase 1: Invoice
# ---------------------------------------------------------------------------

class InvoiceData(StrictBase):
    document_type: Literal["Invoice"]
    direction: Direction
    vendor: str
    vendor_ein: str
    buyer: str
    buyer_ein: str
    document_number: str
    document_date: str  # DD-MM-YYYY
    due_date: Optional[str]  # DD-MM-YYYY or null
    total_amount: float
    vat_amount: float
    currency: Currency
    referenced_numbers: List[str]
    line_items: List[LineItem]
    aviz: bool
    confidence: InvoiceConfidence


# ---------------------------------------------------------------------------
# Phase 1: Receipt
# ---------------------------------------------------------------------------

class ReceiptData(StrictBase):
    document_type: Literal["Receipt"]
    receipt_type: ReceiptType
    receipt_number: str
    vendor: str
    vendor_ein: str
    buyer: str
    buyer_ein: str
    total_amount: float
    document_date: str
    payment_method: PaymentMethod
    currency: Currency
    referenced_numbers: List[str]
    invoice_reference: Optional[str]  # only for payment_receipt
    vat_amount: Optional[float]  # only for independent_receipt
    line_items: List[LineItem]  # empty for payment_receipt
    confidence: ReceiptConfidence


# ---------------------------------------------------------------------------
# Phase 1: Bank Statement
# ---------------------------------------------------------------------------

BankTransactionType = Literal["transfer", "payment", "deposit", "withdrawal"]


class BankTransaction(StrictBase):
    transaction_date: str
    description: str
    reference_number: str
    debit_amount: Optional[float]
    credit_amount: Optional[float]
    balance_after_transaction: float
    transaction_type: BankTransactionType
    referenced_numbers: List[str]


class BankStatementData(StrictBase):
    document_type: Literal["Bank Statement"]
    company_name: str
    company_ein: str
    bank_name: str
    account_number: str
    statement_number: Optional[str]  # null when the statement has no number (don't invent from "Pag 1/9")
    statement_period_start: str
    statement_period_end: str
    opening_balance: float
    closing_balance: float
    currency: Currency
    transactions: List[BankTransaction]


class BankTransactionsChunk(StrictBase):
    """Transactions-only schema for chunked bank-statement extraction.

    A long statement (9–20 pages, 50+ rows) overruns the model's reliable output
    in a single call, so the tail of the transaction list gets dropped. This lets
    the statement be read a page (or page-group) at a time and the rows
    concatenated — see direct_extraction._maybe_chunk_bank_transactions."""
    transactions: List[BankTransaction]


# ---------------------------------------------------------------------------
# Phase 1: Contract
# ---------------------------------------------------------------------------

ContractPartyRole = Literal["client", "vendor", "contractor"]
DeliverableStatus = Literal["pending", "completed"]


class ContractParty(StrictBase):
    name: str
    ein: str
    role: ContractPartyRole


class ContractDeliverable(StrictBase):
    description: str
    due_date: str
    amount: float
    status: DeliverableStatus


class ContractData(StrictBase):
    document_type: Literal["Contract"]
    contract_number: str
    contract_type: str
    parties: List[ContractParty]
    contract_date: str
    start_date: str
    end_date: str
    total_value: float
    currency: Currency
    payment_terms: str
    deliverables: List[ContractDeliverable]
    referenced_numbers: List[str]


# ---------------------------------------------------------------------------
# Phase 1: Z Report
# ---------------------------------------------------------------------------

ZReportPaymentMethod = Literal["cash", "card", "other_payment_method"]


class ZReportVatBreakdown(StrictBase):
    vat_rate: VatRate
    taxable_base: float
    vat_amount: float
    total_amount: float


class ZReportPaymentBreakdown(StrictBase):
    method: ZReportPaymentMethod
    amount: float
    transaction_count: int


class ZReportData(StrictBase):
    document_type: Literal["Z Report"]
    report_number: str
    closing_date: str
    closing_time: str
    fiscal_cash_register_number: str
    report_sequence_number: str
    daily_sales_total: float
    currency: Currency
    vat_breakdown: List[ZReportVatBreakdown]
    fiscal_receipts_issued: int
    initial_cash_balance: Optional[float]
    final_cash_balance: float
    cancellations_refunds: Optional[float]
    payment_methods: List[ZReportPaymentBreakdown]
    referenced_numbers: List[str]


# ---------------------------------------------------------------------------
# Phase 1: Payment Disposition / Collection Disposition (cash forms)
# ---------------------------------------------------------------------------

class PaymentDispositionData(StrictBase):
    document_type: Literal["Payment Disposition"]
    document_number: str
    issue_date: str
    operation_type: Literal["payment"]
    total_amount: float
    currency: Currency
    company_name: str
    company_ein: str
    person_name: str
    person_function: Optional[str]
    description: str
    account_code: str
    referenced_numbers: List[str]


class CollectionDispositionData(StrictBase):
    document_type: Literal["Collection Disposition"]
    document_number: str
    issue_date: str
    operation_type: Literal["collection"]
    total_amount: float
    currency: Currency
    company_name: str
    company_ein: str
    person_name: str
    person_function: Optional[str]
    description: str
    account_code: str
    referenced_numbers: List[str]


# ---------------------------------------------------------------------------
# AutoImport extensions. The Finova engine and its phase/validation contract
# remain unchanged; these schemas add the vehicle-document families required by
# dealerships without weakening strict structured output.
# ---------------------------------------------------------------------------

class CmrConfidence(StrictBase):
    cmr_number: float
    sender_name: float
    consignee_name: float
    carrier_name: float
    loading_date: float
    vin: float


class CmrData(StrictBase):
    document_type: Literal["CMR"]
    cmr_number: str
    sender_name: str
    sender_tax_id: Optional[str]
    consignee_name: str
    consignee_tax_id: Optional[str]
    carrier_name: str
    carrier_tax_id: Optional[str]
    carrier_country: Optional[str]
    place_of_loading: str
    place_of_delivery: str
    loading_date: Optional[str]
    vehicle_plate: Optional[str]
    trailer_plate: Optional[str]
    goods_description: str
    gross_weight_kg: Optional[float]
    vin: Optional[str]
    referenced_numbers: List[str]
    confidence: CmrConfidence


class CustomsConfidence(StrictBase):
    mrn: float
    document_date: float
    customs_value: float
    vin: float


class CustomsDeclarationData(StrictBase):
    document_type: Literal["Customs Declaration"]
    mrn: str
    document_date: Optional[str]
    customs_office: Optional[str]
    declarant_name: Optional[str]
    declarant_tax_id: Optional[str]
    customs_value: Optional[float]
    currency: Optional[Currency]
    duties_paid: Optional[float]
    vat_paid: Optional[float]
    tariff_code: Optional[str]
    gross_weight_kg: Optional[float]
    vin: Optional[str]
    referenced_numbers: List[str]
    confidence: CustomsConfidence


class RegistrationConfidence(StrictBase):
    vin: float
    make: float
    model: float
    first_registration_date: float
    registration_number: float


class VehicleRegistrationData(StrictBase):
    document_type: Literal["Vehicle Registration Certificate"]
    vin: str
    make: str
    model: str
    variant: Optional[str]
    first_registration_date: Optional[str]
    registration_number: Optional[str]
    owner_name: Optional[str]
    owner_address: Optional[str]
    fuel_type: Optional[str]
    engine_capacity_cm3: Optional[int]
    power_kw: Optional[int]
    emissions_class: Optional[str]
    mass_kg: Optional[int]
    color: Optional[str]
    confidence: RegistrationConfidence


class InspectionConfidence(StrictBase):
    vin: float
    inspection_date: float
    valid_until: float
    result: float


class TechnicalInspectionData(StrictBase):
    document_type: Literal["Technical Inspection (ITP)"]
    vin: str
    registration_number: Optional[str]
    inspection_date: Optional[str]
    valid_until: Optional[str]
    result: str
    station_name: Optional[str]
    mileage_km: Optional[int]
    confidence: InspectionConfidence


class InsuranceConfidence(StrictBase):
    policy_number: float
    vin: float
    start_date: float
    end_date: float
    premium_amount: float


class InsuranceData(StrictBase):
    document_type: Literal["Insurance"]
    policy_number: str
    insurer_name: str
    insured_name: str
    vin: Optional[str]
    registration_number: Optional[str]
    start_date: Optional[str]
    end_date: Optional[str]
    premium_amount: Optional[float]
    currency: Optional[Currency]
    confidence: InsuranceConfidence


class OtherConfidence(StrictBase):
    summary: float
    document_date: float


class OtherDocumentData(StrictBase):
    document_type: Literal["Other"]
    summary: str
    document_date: Optional[str]
    parties: List[str]
    referenced_numbers: List[str]
    confidence: OtherConfidence


# ---------------------------------------------------------------------------
# Schema registry — keyed by the document_type string the categorizer emits
# ---------------------------------------------------------------------------

EXTRACTION_SCHEMAS = {
    "Invoice": InvoiceData,
    "Receipt": ReceiptData,
    "Bank Statement": BankStatementData,
    "Contract": ContractData,
    "Z Report": ZReportData,
    "Payment Disposition": PaymentDispositionData,
    "Collection Disposition": CollectionDispositionData,
    "CMR": CmrData,
    "Customs Declaration": CustomsDeclarationData,
    "Vehicle Registration Certificate": VehicleRegistrationData,
    "Technical Inspection (ITP)": TechnicalInspectionData,
    "Insurance": InsuranceData,
    "Other": OtherDocumentData,
}


def schema_for(document_type: str) -> type[StrictBase]:
    if document_type not in EXTRACTION_SCHEMAS:
        raise ValueError(
            f"No extraction schema registered for document_type={document_type!r}. "
            f"Known types: {sorted(EXTRACTION_SCHEMAS.keys())}"
        )
    return EXTRACTION_SCHEMAS[document_type]
