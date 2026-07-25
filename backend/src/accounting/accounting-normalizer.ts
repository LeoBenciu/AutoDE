export type AccountingDirection = 'incoming' | 'outgoing';
export type VatDeductibility = 'FULL' | 'PARTIAL_50' | 'NONE';

export interface CanonicalLineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  netAmount: number;
  vatAmount: number;
  vatRate: number;
  vatCode: string;
  unit: string;
  accountCode: string;
  articleCode: string;
  management?: string;
  articleType: string;
  vatDeductibility: VatDeductibility;
  raw: Record<string, any>;
}

export interface CanonicalAccountingDocument {
  documentType: string;
  direction?: AccountingDirection;
  vendor: string;
  vendorEin: string;
  vendorCountry: string;
  vendorIban?: string;
  buyer: string;
  buyerEin: string;
  buyerCountry: string;
  documentNumber: string;
  documentDate?: string;
  dueDate?: string;
  totalAmount: number;
  vatAmount: number;
  netAmount: number;
  currency: string;
  exchangeRate?: number;
  reverseCharge: boolean;
  isAdvance: boolean;
  aviz: boolean;
  receiptType?: 'payment_receipt' | 'independent_receipt';
  paymentMethod?: 'cash' | 'bank';
  referencedNumbers: string[];
  referencedInvoices: Array<{ number: string; amount?: number }>;
  accountCode?: string;
  lineItems: CanonicalLineItem[];
  raw: Record<string, any>;
}

const VAT_RATE_MAP: Record<string, number> = {
  ZERO: 0,
  ONE: 1,
  FIVE: 5,
  NINE: 9,
  ELEVEN: 11,
  NINETEEN: 19,
  TWENTYONE: 21,
  TWENTY_FOUR: 24,
};

const TYPE_ALIASES: Record<string, string> = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  'payment disposition': 'Payment Disposition',
  paymentdisposition: 'Payment Disposition',
  'collection disposition': 'Collection Disposition',
  collectiondisposition: 'Collection Disposition',
};

export function unwrapExtractedFields(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const object = value as Record<string, any>;
  if (object.result && typeof object.result === 'object' && !Array.isArray(object.result)) {
    return object.result as Record<string, any>;
  }
  return object;
}

export function normalizeAccountingDocument(
  documentType: string | null | undefined,
  extractedFields: unknown,
  tenantCui?: string | null,
): CanonicalAccountingDocument {
  const raw = unwrapExtractedFields(extractedFields);
  const normalizedType =
    TYPE_ALIASES[String(raw.document_type ?? documentType ?? '').trim().toLowerCase()] ??
    String(raw.document_type ?? documentType ?? 'Other').trim();

  const vendorEin = normalizeEin(raw.vendor_ein ?? raw.supplier_tax_id);
  const buyerEin = normalizeEin(raw.buyer_ein ?? raw.customer_tax_id);
  const companyEin = normalizeEin(tenantCui);
  let direction = normalizeDirection(raw.direction);
  if (companyEin && buyerEin === companyEin) direction = 'incoming';
  if (companyEin && vendorEin === companyEin) direction = 'outgoing';

  const totalAmount = positiveNumber(
    raw.total_amount ?? raw.grand_total ?? raw.total ?? raw.amount,
  );
  const vatAmount = Math.min(
    totalAmount,
    positiveNumber(raw.vat_amount ?? raw.total_vat ?? raw.tva),
  );
  const explicitNet = positiveNumber(raw.net_amount ?? raw.net_total ?? raw.subtotal);
  const netAmount = explicitNet || Math.max(0, round2(totalAmount - vatAmount));
  const lines = Array.isArray(raw.line_items) ? raw.line_items : [];
  const hasStructuredReferences = Array.isArray(raw.referenced_invoices);
  const extractedReferences = hasStructuredReferences
    ? raw.referenced_invoices
        .map((reference: unknown) => {
          if (typeof reference === 'string') {
            return { number: reference.trim() };
          }
          if (
            reference &&
            typeof reference === 'object' &&
            !Array.isArray(reference)
          ) {
            const object = reference as Record<string, unknown>;
            const number = stringValue(
              object.number ??
                object.document_number ??
                object.invoice_number ??
                object.reference,
            );
            const amount = optionalPositiveNumber(
              object.amount ?? object.payment_amount ?? object.paid_amount,
            );
            return number ? { number, amount } : undefined;
          }
          return undefined;
        })
        .filter(
          (
            reference,
          ): reference is { number: string; amount?: number } =>
            Boolean(reference?.number),
        )
    : [];
  const referencedNumbers = uniqueStrings([
    ...extractedReferences.map((reference) => reference.number),
    ...(!hasStructuredReferences && Array.isArray(raw.referenced_numbers)
      ? raw.referenced_numbers
      : []),
    ...(!hasStructuredReferences
      ? [raw.invoice_reference, raw.reference_number]
      : []),
  ]);
  const referencedInvoices = referencedNumbers.map((number) => ({
    number,
    amount: extractedReferences.find(
      (reference) =>
        normalizeReferenceValue(reference.number) === normalizeReferenceValue(number),
    )?.amount,
  }));
  const receiptType = normalizeReceiptType(raw.receipt_type, referencedNumbers.length > 0);
  const paymentMethod = normalizePaymentMethod(raw.payment_method ?? raw.payment_info);

  return {
    documentType: normalizedType,
    direction,
    vendor: stringValue(raw.vendor ?? raw.supplier_name ?? raw.merchant_name),
    vendorEin,
    vendorCountry: normalizeCountry(raw.vendor_country ?? raw.supplier_country),
    vendorIban: optionalString(raw.vendor_iban ?? raw.supplier_iban),
    buyer: stringValue(raw.buyer ?? raw.customer_name),
    buyerEin,
    buyerCountry: normalizeCountry(raw.buyer_country ?? raw.customer_country),
    documentNumber: stringValue(
      raw.document_number ?? raw.invoice_number ?? raw.receipt_number,
    ),
    documentDate: normalizeDate(
      raw.document_date ?? raw.invoice_date ?? raw.issue_date ?? raw.date,
    ),
    dueDate: normalizeDate(raw.due_date),
    totalAmount,
    vatAmount,
    netAmount,
    currency: normalizeCurrency(raw.currency),
    exchangeRate: optionalPositiveNumber(
      raw.exchangeRate ?? raw.exchange_rate ?? raw.curs_valutar ?? raw.curs,
    ),
    reverseCharge:
      raw.reverse_charge === true ||
      String(raw.reverse_charge ?? '').toLowerCase() === 'true',
    isAdvance:
      raw.is_advance === true ||
      raw.advance === true ||
      ['advance', 'avans'].includes(
        stringValue(raw.invoice_kind ?? raw.payment_kind).toLowerCase(),
      ),
    aviz: raw.aviz === true,
    receiptType,
    paymentMethod,
    referencedNumbers,
    referencedInvoices,
    accountCode: optionalString(raw.account_code ?? raw.accountCode),
    lineItems: lines.map((line, index) => normalizeLineItem(line, index)),
    raw,
  };
}

export function normalizeDate(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    return validDate(Number(match[3]), Number(match[2]), Number(match[1]));
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

export function normalizeEin(value: unknown): string {
  return stringValue(value)
    .toUpperCase()
    .replace(/^RO/, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function normalizeVatRate(value: unknown): number {
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    value = object.name ?? object.value;
  }
  const text = stringValue(value).toUpperCase();
  if (VAT_RATE_MAP[text] != null) return VAT_RATE_MAP[text];
  const numeric = Number(text.replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

export function vatCodeFromRate(rate: number): string {
  const found = Object.entries(VAT_RATE_MAP).find(([, numeric]) => numeric === rate);
  return found?.[0] ?? String(rate);
}

export function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeLineItem(value: unknown, index: number): CanonicalLineItem {
  const line =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  const quantity = positiveNumber(line.quantity) || 1;
  const unitPrice = positiveNumber(line.unit_price ?? line.unitPrice ?? line.pret);
  const vatAmount = positiveNumber(line.vat_amount ?? line.tva);
  const explicitNet = positiveNumber(
    line.net_amount ?? line.line_total ?? line.total ?? line.valoare,
  );
  const netAmount = explicitNet || round2(quantity * unitPrice);
  const vatRate = normalizeVatRate(line.vat_rate ?? line.vat ?? line.proc_tva);

  return {
    name: stringValue(line.name ?? line.description) || `Articol ${index + 1}`,
    quantity,
    unitPrice: unitPrice || (quantity ? round2(netAmount / quantity) : netAmount),
    netAmount,
    vatAmount,
    vatRate,
    vatCode: stringValue(line.vat) || vatCodeFromRate(vatRate),
    unit: stringValue(line.um ?? line.unitOfMeasure) || 'BUCATA',
    accountCode: stringValue(line.account_code ?? line.accountCode ?? line.cont),
    articleCode: stringValue(
      line.articleCode ?? line.article_code ?? line.cod_articol_client,
    ),
    management: optionalString(line.management ?? line.gestiune),
    articleType: stringValue(line.article_type ?? line.itemType) || 'MARFURI',
    vatDeductibility: normalizeDeductibility(
      line.vat_deductibility ?? line.deduction_type ?? line.tip_deducere,
    ),
    raw: line,
  };
}

function normalizeDirection(value: unknown): AccountingDirection | undefined {
  const text = stringValue(value).toLowerCase();
  if (['incoming', 'intrare', 'achizitie', 'purchase'].includes(text)) return 'incoming';
  if (['outgoing', 'iesire', 'vanzare', 'sale'].includes(text)) return 'outgoing';
  return undefined;
}

function normalizeReceiptType(
  value: unknown,
  hasReferences: boolean,
): CanonicalAccountingDocument['receiptType'] {
  const text = stringValue(value).toLowerCase();
  if (text === 'payment_receipt' || hasReferences) return 'payment_receipt';
  if (text === 'independent_receipt') return 'independent_receipt';
  return undefined;
}

function normalizePaymentMethod(
  value: unknown,
): CanonicalAccountingDocument['paymentMethod'] {
  const text = stringValue(value).toLowerCase();
  if (
    ['bank', 'transfer', 'card'].some((term) => text.includes(term)) ||
    text.includes('5121') ||
    text.includes('5124')
  ) {
    return 'bank';
  }
  if (text) return 'cash';
  return undefined;
}

function normalizeDeductibility(value: unknown): VatDeductibility {
  const text = stringValue(value).toUpperCase();
  if (text === 'PARTIAL_50' || text === 'N50') return 'PARTIAL_50';
  if (text === 'NONE' || text === 'I') return 'NONE';
  return 'FULL';
}

function normalizeCurrency(value: unknown): string {
  const text = stringValue(value).toUpperCase();
  if (['LEI', 'LEU'].includes(text)) return 'RON';
  if (text === 'EURO' || text === '€') return 'EUR';
  return text || 'RON';
}

function normalizeCountry(value: unknown): string {
  const text = stringValue(value).toUpperCase();
  return text || 'RO';
}

function positiveNumber(value: unknown): number {
  if (typeof value === 'string') {
    value = value.replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? round2(numeric) : 0;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const numeric = positiveNumber(value);
  return numeric > 0 ? numeric : undefined;
}

function stringValue(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function optionalString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text || undefined;
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) =>
          typeof value === 'string' && value.includes(',')
            ? value.split(',')
            : [value],
        )
        .map(stringValue)
        .filter(Boolean),
    ),
  );
}

function normalizeReferenceValue(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
}

function validDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
