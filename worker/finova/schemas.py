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
    "Vehicle Registration Certificate",
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
VehicleTransaction = Literal["purchase", "cost", "other"]
VehicleCostCategory = Literal[
    "TRANSPORT", "CUSTOMS", "VAT", "ITP", "REGISTRATION", "REFURB", "OTHER",
]


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
    "Vehicle Registration Certificate",
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
    vehicle_cost_category: Optional[VehicleCostCategory]


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
    tariff_code: Optional[str]
    vendor_country: Optional[str]
    vendor_registration: Optional[str]
    vendor_address: Optional[str]
    vendor_city: Optional[str]
    vendor_county: Optional[str]
    vendor_phone: Optional[str]
    vendor_email: Optional[str]
    vendor_bank_name: Optional[str]
    vendor_iban: Optional[str]
    buyer_country: Optional[str]
    buyer_registration: Optional[str]
    buyer_address: Optional[str]
    buyer_city: Optional[str]
    buyer_county: Optional[str]
    buyer_phone: Optional[str]
    buyer_email: Optional[str]
    buyer_bank_name: Optional[str]
    buyer_iban: Optional[str]
    vin: Optional[str]
    vehicle_make: Optional[str]
    vehicle_model: Optional[str]
    vehicle_variant: Optional[str]
    vehicle_year: Optional[int]
    first_registration_date: Optional[str]
    mileage_km: Optional[int]
    vehicle_origin_country: Optional[str]
    vehicle_transaction: VehicleTransaction
    referenced_numbers: List[str]
    reverse_charge: bool
    vat_on_collection: bool
    line_items: List[LineItem]
    aviz: bool
    confidence: InvoiceConfidence


# ---------------------------------------------------------------------------
# Phase 1: Receipt
# ---------------------------------------------------------------------------

class ReceiptData(StrictBase):
    document_type: Literal["Receipt"]
    direction: Optional[Direction]
    receipt_type: ReceiptType
    receipt_number: str
    vendor: str
    vendor_ein: str
    vendor_country: Optional[str]
    vendor_address: Optional[str]
    vendor_city: Optional[str]
    vendor_county: Optional[str]
    buyer: str
    buyer_ein: str
    buyer_country: Optional[str]
    buyer_address: Optional[str]
    buyer_city: Optional[str]
    buyer_county: Optional[str]
    total_amount: float
    document_date: str
    payment_method: PaymentMethod
    currency: Currency
    vin: Optional[str]
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
ContractPartyKind = Literal["INDIVIDUAL", "COMPANY"]
ContractPartyIdentifierType = Literal["CUI", "CNP", "FOREIGN_ID"]
DeliverableStatus = Literal["pending", "completed"]


class ContractParty(StrictBase):
    name: str
    ein: str
    role: ContractPartyRole
    kind: ContractPartyKind
    identifier_type: ContractPartyIdentifierType
    country: Optional[str]
    registration: Optional[str]
    address: Optional[str]
    city: Optional[str]
    county: Optional[str]
    phone: Optional[str]
    email: Optional[str]
    bank_name: Optional[str]
    iban: Optional[str]


class ContractDeliverable(StrictBase):
    description: str
    due_date: str
    amount: float
    status: DeliverableStatus


class ContractData(StrictBase):
    document_type: Literal["Contract"]
    direction: Optional[Direction]
    contract_number: str
    contract_type: str
    parties: List[ContractParty]
    contract_date: str
    start_date: str
    end_date: str
    total_value: float
    currency: Currency
    tariff_code: Optional[str]
    payment_terms: str
    deliverables: List[ContractDeliverable]
    vin: Optional[str]
    vehicle_make: Optional[str]
    vehicle_model: Optional[str]
    vehicle_variant: Optional[str]
    vehicle_year: Optional[int]
    first_registration_date: Optional[str]
    mileage_km: Optional[int]
    vehicle_transaction: Literal["purchase", "other"]
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
    tariff_code: Optional[str]
    gross_weight_kg: Optional[float]
    vin: Optional[str]
    referenced_numbers: List[str]
    confidence: CmrConfidence


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
    vehicle_year: Optional[int]
    first_registration_date: Optional[str]
    registration_number: Optional[str]
    registration_country: Optional[str]
    owner_name: Optional[str]
    owner_address: Optional[str]
    fuel_type: Optional[str]
    engine_capacity_cm3: Optional[int]
    power_kw: Optional[int]
    emissions_class: Optional[str]
    mass_kg: Optional[int]
    color: Optional[str]
    confidence: RegistrationConfidence


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
# e-Transport: logistics copied from a WhatsApp/email message
# ---------------------------------------------------------------------------

class TransportMessageData(StrictBase):
    transporter_name: Optional[str]
    transporter_tax_id: Optional[str]
    transporter_country: Optional[str]  # ISO alpha-2 when identifiable
    vehicle_plate: Optional[str]
    trailer_plate: Optional[str]
    loading_city: Optional[str]
    loading_country: Optional[str]  # ISO alpha-2 when identifiable
    unloading_city: Optional[str]
    unloading_county: Optional[str]
    transport_date: Optional[str]  # YYYY-MM-DD


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
    "Vehicle Registration Certificate": VehicleRegistrationData,
    "Other": OtherDocumentData,
}


def schema_for(document_type: str) -> type[StrictBase]:
    if document_type not in EXTRACTION_SCHEMAS:
        raise ValueError(
            f"No extraction schema registered for document_type={document_type!r}. "
            f"Known types: {sorted(EXTRACTION_SCHEMAS.keys())}"
        )
    return EXTRACTION_SCHEMAS[document_type]
