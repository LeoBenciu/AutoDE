"""Pydantic schemas for the phased extraction pipeline.

Phase 0 categorizes the document; phase 1 runs the schema registered for the
detected type. Each phase-1 call is wrapped in an envelope that also asks the
model for per-field confidences (validated deterministically afterwards —
a field with a failed validator is never left "high confidence").
"""
from typing import List, Literal, Optional, Type

from pydantic import BaseModel, Field, create_model

DocumentType = Literal[
    "Invoice",
    "Receipt",
    "Bank Statement",
    "Contract",
    "Z Report",
    "Payment Disposition",
    "CMR",
    "Vehicle Registration Certificate",
    "Other",
]


class Categorization(BaseModel):
    document_type: DocumentType
    direction: Optional[Literal["incoming", "outgoing"]] = Field(
        None, description="For invoices: incoming (purchase) or outgoing (sale)."
    )
    language: Optional[str] = Field(None, description="ISO 639-1 language code of the document")
    confidence: float = Field(..., description="0..1 confidence in the classification")


class LineItem(BaseModel):
    description: str
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    net_amount: Optional[float] = Field(None, description="Line total WITHOUT VAT (net convention)")
    vat_rate: Optional[float] = None
    vehicle_cost_category: Optional[str] = None


class Invoice(BaseModel):
    """Purchase/sale invoice. Amount convention: line totals are NET; gross = net + VAT."""

    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = Field(None, description="ISO date YYYY-MM-DD")
    due_date: Optional[str] = Field(None, description="ISO date YYYY-MM-DD")
    supplier_name: Optional[str] = None
    supplier_tax_id: Optional[str] = None
    supplier_country: Optional[str] = None
    supplier_iban: Optional[str] = None
    customer_name: Optional[str] = None
    customer_tax_id: Optional[str] = None
    currency: Optional[str] = None
    net_amount: Optional[float] = None
    vat_amount: Optional[float] = None
    total_amount: Optional[float] = Field(None, description="Gross total = net + VAT")
    tariff_code: Optional[str] = Field(None, description="NC/tariff code only when printed")
    line_items: List[LineItem] = Field(default_factory=list)
    # Auto-specific: invoices for cars usually carry the vehicle identity
    vin: Optional[str] = Field(None, description="17-char chassis/VIN if present")
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    first_registration_date: Optional[str] = Field(None, description="ISO date")
    mileage_km: Optional[int] = None
    vehicle_variant: Optional[str] = None
    vehicle_year: Optional[int] = None
    vehicle_transaction: Optional[str] = Field(
        None, description="purchase, cost, or other"
    )
    vehicle_cost_category: Optional[str] = None


class Receipt(BaseModel):
    receipt_number: Optional[str] = None
    date: Optional[str] = None
    merchant_name: Optional[str] = None
    merchant_tax_id: Optional[str] = None
    currency: Optional[str] = None
    total_amount: Optional[float] = None
    vat_amount: Optional[float] = None
    payment_method: Optional[str] = None
    vin: Optional[str] = None
    vehicle_cost_category: Optional[str] = None


class BankStatementTransaction(BaseModel):
    date: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = Field(None, description="Negative for debits, positive for credits")
    balance_after: Optional[float] = None
    reference: Optional[str] = None


class BankStatement(BaseModel):
    bank_name: Optional[str] = None
    iban: Optional[str] = None
    currency: Optional[str] = None
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    opening_balance: Optional[float] = None
    closing_balance: Optional[float] = None
    transactions: List[BankStatementTransaction] = Field(default_factory=list)


class ContractParty(BaseModel):
    name: str
    tax_id: Optional[str] = None
    role: Optional[str] = Field(None, description="e.g. seller, buyer, lessor")
    kind: Optional[str] = Field(None, description="INDIVIDUAL or COMPANY")
    country: Optional[str] = None


class Deliverable(BaseModel):
    description: str
    due_date: Optional[str] = None
    amount: Optional[float] = None
    status: Optional[str] = None


class Contract(BaseModel):
    contract_number: Optional[str] = None
    contract_type: Optional[str] = None
    parties: List[ContractParty] = Field(default_factory=list)
    contract_date: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    total_value: Optional[float] = None
    currency: Optional[str] = None
    tariff_code: Optional[str] = Field(None, description="NC/tariff code only when printed")
    payment_terms: Optional[str] = None
    deliverables: List[Deliverable] = Field(default_factory=list)
    vin: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_variant: Optional[str] = None
    vehicle_year: Optional[int] = None
    first_registration_date: Optional[str] = None
    mileage_km: Optional[int] = None
    vehicle_transaction: Optional[str] = Field(
        None, description="purchase for a vehicle acquisition, otherwise other"
    )
    direction: Optional[str] = None


class ZReport(BaseModel):
    report_number: Optional[str] = None
    date: Optional[str] = None
    total_sales: Optional[float] = None
    total_vat: Optional[float] = None
    currency: Optional[str] = None


class PaymentDisposition(BaseModel):
    number: Optional[str] = None
    date: Optional[str] = None
    amount: Optional[float] = None
    currency: Optional[str] = None
    payee: Optional[str] = None
    purpose: Optional[str] = None


class CMR(BaseModel):
    """International consignment note — feeds the e-Transport declaration."""

    cmr_number: Optional[str] = None
    sender_name: Optional[str] = None
    consignee_name: Optional[str] = None
    carrier_name: Optional[str] = None
    carrier_tax_id: Optional[str] = None
    carrier_country: Optional[str] = None
    place_of_loading: Optional[str] = None
    place_of_delivery: Optional[str] = None
    loading_date: Optional[str] = None
    vehicle_plate: Optional[str] = Field(None, description="Tractor/truck registration plate")
    trailer_plate: Optional[str] = None
    goods_description: Optional[str] = None
    tariff_code: Optional[str] = Field(None, description="NC/tariff code only when printed")
    gross_weight_kg: Optional[float] = None
    vin: Optional[str] = Field(None, description="VIN of the transported car, if listed")


class RegistrationCertificate(BaseModel):
    """Vehicle registration certificate (DE Fahrzeugbrief / Zulassungsbescheinigung etc.)."""

    vin: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    variant: Optional[str] = None
    vehicle_year: Optional[int] = None
    first_registration_date: Optional[str] = Field(None, description="ISO date")
    registration_number: Optional[str] = None
    registration_country: Optional[str] = None
    owner_name: Optional[str] = None
    fuel_type: Optional[str] = None
    engine_capacity_cm3: Optional[int] = None
    power_kw: Optional[int] = None
    emissions_class: Optional[str] = None
    mass_kg: Optional[int] = None
    color: Optional[str] = None


class OtherDocument(BaseModel):
    summary: Optional[str] = Field(None, description="One-sentence summary of the document")
    date: Optional[str] = None
    parties: List[str] = Field(default_factory=list)


SCHEMA_REGISTRY: dict[str, Type[BaseModel]] = {
    "Invoice": Invoice,
    "Receipt": Receipt,
    "Bank Statement": BankStatement,
    "Contract": Contract,
    "Z Report": ZReport,
    "Payment Disposition": PaymentDisposition,
    "CMR": CMR,
    "Vehicle Registration Certificate": RegistrationCertificate,
    "Other": OtherDocument,
}


class FieldConfidence(BaseModel):
    field: str
    confidence: float = Field(..., description="0..1 confidence for this specific field")


_ENVELOPE_CACHE: dict[str, Type[BaseModel]] = {}


def envelope_for(doc_type: str) -> Type[BaseModel]:
    """Extraction envelope: typed fields + per-field confidences in one strict schema."""
    if doc_type not in _ENVELOPE_CACHE:
        schema = SCHEMA_REGISTRY.get(doc_type, OtherDocument)
        _ENVELOPE_CACHE[doc_type] = create_model(
            f"{schema.__name__}Envelope",
            fields=(schema, ...),
            confidences=(List[FieldConfidence], Field(default_factory=list)),
        )
    return _ENVELOPE_CACHE[doc_type]
