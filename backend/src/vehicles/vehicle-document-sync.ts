import { CostCategory, Prisma, VehicleStatus } from '@prisma/client';
import {
  CanonicalAccountingDocument,
  CanonicalLineItem,
  isVehiclePurchaseContract,
  normalizeAccountingDocument,
  normalizeDate,
  round2,
  unwrapExtractedFields,
} from '../accounting/accounting-normalizer';
import {
  ensureVehicleArticle,
  vehicleArticleCode,
} from '../accounting/vehicle-article';
import { resolveExchangeRateToRon } from '../accounting/fx';
import { PrismaService } from '../common/prisma.service';

type DbClient = Prisma.TransactionClient | PrismaService;

interface VehicleCandidate {
  vin?: string;
  make?: string;
  model?: string;
  variant?: string;
  year?: number;
  firstRegistered?: Date;
  mileageKm?: number;
  fuelType?: string;
  color?: string;
  originCountry?: string;
  purchasePrice?: number;
  purchaseCurrency?: string;
  purchase: boolean;
}

export function isVehiclePurchaseDocument(
  canonical: CanonicalAccountingDocument,
): boolean {
  if (isVehiclePurchaseContract(canonical)) return true;
  if (canonical.documentType !== 'Invoice' || canonical.direction === 'outgoing') {
    return false;
  }
  const transaction = text(canonical.raw.vehicle_transaction).toLowerCase();
  if (transaction === 'purchase') return true;
  if (transaction === 'cost' || transaction === 'other') return false;
  return Boolean(
    normalizeVin(canonical.raw.vin) &&
      canonical.lineItems.some(
        (line) =>
          /^371/.test(line.accountCode) ||
          /\b(auto|autoturism|vehicle|vehicul|fahrzeug)\b/i.test(line.name),
      ),
  );
}

/**
 * Pre-fills a vehicle purchase invoice before it reaches review. The vehicle
 * itself is the only stock line (371), is bound to the complete VIN article and
 * may use the brand management. Transport is always posted to 624, while every
 * other ancillary service or tax is posted to 628 and is not a stock article.
 */
export function applyVehiclePurchaseInvoiceDefaults(
  extractedFields: unknown,
  managements: Array<{ code: string; name: string }>,
  tenantCui?: string | null,
): boolean {
  const fields = unwrapExtractedFields(extractedFields);
  const lines = Array.isArray(fields.line_items) ? fields.line_items : [];
  if (lines.length === 0) return false;

  const canonical = normalizeAccountingDocument('Invoice', fields, tenantCui);
  if (canonical.documentType !== 'Invoice' || !isVehiclePurchaseDocument(canonical)) {
    return false;
  }

  const vehicleLines = selectVehiclePurchaseLines(lines);
  if (vehicleLines.length === 0) return false;

  const description = vehicleModelDescription(fields);
  const managementCode = brandManagementCode(fields, managements);
  const articleCode = vehicleArticleCode(
    fields.vin ?? fields.vehicle_vin ?? fields.chassis_number,
  );

  let changed = false;
  for (const line of vehicleLines) {
    if (!line || typeof line !== 'object') continue;
    if (!/^371(?:\.|$)/.test(text(line.account_code ?? line.accountCode))) {
      line.account_code = '371';
      if ('accountCode' in line) line.accountCode = '371';
      changed = true;
    }
    if (description && text(line.name ?? line.description) !== description) {
      line.name = description;
      if ('description' in line) line.description = description;
      changed = true;
    }
    if (managementCode && text(line.management) !== managementCode) {
      line.management = managementCode;
      changed = true;
    }
    if (
      articleCode &&
      text(line.articleCode ?? line.article_code) !== articleCode
    ) {
      line.articleCode = articleCode;
      if ('article_code' in line) line.article_code = articleCode;
      changed = true;
    }
  }

  const vehicleLineSet = new Set(vehicleLines);
  for (const line of lines) {
    if (!line || typeof line !== 'object' || vehicleLineSet.has(line)) continue;
    const expectedAccount = isFreightInLine(line) ? '624' : '628';
    const account = text(line.account_code ?? line.accountCode);
    if (!new RegExp(`^${expectedAccount}(?:\\.|$)`).test(account)) {
      line.account_code = expectedAccount;
      if ('accountCode' in line) line.accountCode = expectedAccount;
      changed = true;
    }
    if (text(line.articleCode ?? line.article_code) !== '') {
      line.articleCode = '';
      if ('article_code' in line) line.article_code = '';
      changed = true;
    }
    if (line.isNew !== false) {
      line.isNew = false;
      changed = true;
    }
    if (text(line.management) !== '') {
      line.management = null;
      changed = true;
    }
  }

  return changed;
}

function selectVehiclePurchaseLines(lines: any[]): any[] {
  const semanticMatches = lines.filter(
    (line) => !isAncillaryVehicleCostLine(line) && hasVehicleLineDescription(line),
  );
  if (semanticMatches.length > 0) return semanticMatches;

  const stockMatches = lines.filter(
    (line) =>
      !isAncillaryVehicleCostLine(line) &&
      /^371(?:\.|$)/.test(text(line?.account_code ?? line?.accountCode)),
  );
  if (stockMatches.length > 0) return stockMatches;

  const [single] = lines;
  return lines.length === 1 && !isAncillaryVehicleCostLine(single) ? [single] : [];
}

function hasVehicleLineDescription(line: any): boolean {
  const name = text(line?.name ?? line?.description);
  return /\b(auto|autoturism|automobil|vehicle|vehicul|fahrzeug|pkw)\b/i.test(name);
}

function isFreightInLine(line: any): boolean {
  if (!line || typeof line !== 'object') return false;
  const name = text(line.name ?? line.description)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  return /transport|freight|fracht|delivery|livrare|platform|tractare|remorcare|\btow\b/.test(
    name,
  );
}

function isAncillaryVehicleCostLine(line: any): boolean {
  if (isFreightInLine(line)) return true;
  const name = text(line?.name ?? line?.description)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  return /\b(document|handling|procesare|pregatire|taxa|fee|customs|vama|tva|vat|itp|inspection|inspectie|registration|inmatriculare|rar|service|repair|reparatie|refurb|recondition|piese|parts)\b/.test(
    name,
  );
}

/** Applies the client's SAGA account convention to extracted vehicle costs. */
export function applyVehicleCostAccountDefaults(
  documentType: string | null | undefined,
  extractedFields: unknown,
  tenantCui?: string | null,
): boolean {
  if (documentType !== 'Invoice' && documentType !== 'Receipt') return false;
  const fields = unwrapExtractedFields(extractedFields);
  const lines = Array.isArray(fields.line_items) ? fields.line_items : [];
  if (lines.length === 0) return false;

  const canonical = normalizeAccountingDocument(documentType, fields, tenantCui);
  if (!isVehicleCostDocument(canonical)) return false;

  let changed = false;
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const explicitCategory = text(line.vehicle_cost_category).toUpperCase();
    const isTransport =
      explicitCategory === CostCategory.TRANSPORT ||
      (explicitCategory === '' && isFreightInLine(line));
    const expectedAccount = isTransport ? '624' : '628';
    if (
      !new RegExp(`^${expectedAccount}(?:\\.|$)`).test(
        text(line.account_code ?? line.accountCode),
      )
    ) {
      line.account_code = expectedAccount;
      if ('accountCode' in line) line.accountCode = expectedAccount;
      changed = true;
    }
    if (text(line.articleCode ?? line.article_code) !== '') {
      line.articleCode = '';
      if ('article_code' in line) line.article_code = '';
      changed = true;
    }
    if (line.isNew !== false) {
      line.isNew = false;
      changed = true;
    }
    if (text(line.management) !== '') {
      line.management = null;
      changed = true;
    }
  }
  return changed;
}

function vehicleModelDescription(fields: Record<string, any>): string {
  return [
    fields.vehicle_make ?? fields.make,
    fields.vehicle_model ?? fields.model,
    fields.vehicle_variant ?? fields.variant,
  ]
    .map(text)
    .filter(Boolean)
    .join(' ');
}

function brandManagementCode(
  fields: Record<string, any>,
  managements: Array<{ code: string; name: string }>,
): string | undefined {
  const brand = normalizeBrand(fields.vehicle_make ?? fields.make);
  if (!brand || managements.length === 0) return undefined;
  const exact = managements.find(
    (management) =>
      normalizeBrand(management.name) === brand ||
      normalizeBrand(management.code) === brand,
  );
  if (exact) return exact.code;
  const prefixed = managements.find((management) => {
    const name = normalizeBrand(management.name);
    return name.length >= 3 && (brand.startsWith(name) || name.startsWith(brand));
  });
  return prefixed?.code;
}

function normalizeBrand(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

export function isVehicleCostDocument(
  canonical: CanonicalAccountingDocument,
  vehicleId?: number | null,
): boolean {
  if (
    !['Invoice', 'Receipt'].includes(canonical.documentType) ||
    canonical.direction === 'outgoing' ||
    canonical.receiptType === 'payment_receipt' ||
    isVehiclePurchaseDocument(canonical)
  ) {
    return false;
  }

  // A fiscal receipt is an ordinary accounting document by default. Fuel,
  // maintenance and similar descriptions do not prove that the expense belongs
  // to a stock vehicle: they can just as well be general company expenses. Only
  // an explicit association made by the user turns a receipt into a vehicle cost.
  // This also prevents an extracted/hallucinated cost category from rewriting a
  // perfectly valid account (for example fuel 6022) to 628.
  if (canonical.documentType === 'Receipt') {
    return vehicleId != null;
  }

  const hasExplicitCostCategory = canonical.lineItems.some((line) =>
    isCostCategory(text(line.raw.vehicle_cost_category).toUpperCase()),
  );
  return (
    text(canonical.raw.vehicle_transaction).toLowerCase() === 'cost' ||
    hasExplicitCostCategory ||
    vehicleId != null
  );
}

export function vehicleCostReviewErrors(
  canonical: CanonicalAccountingDocument,
  vehicleId?: number | null,
): string[] {
  if (!isVehicleCostDocument(canonical, vehicleId)) return [];

  const errors: string[] = [];
  if (vehicleId == null) {
    errors.push('Asociază documentul de cost cu vehiculul înainte de aprobare');
  }

  const missingLines = canonical.lineItems
    .map((line, index) => {
      const lineCategory = text(line.raw.vehicle_cost_category).toUpperCase();
      const automaticCategory =
        lineCategory === ''
          ? defaultVehicleCostCategoryForAccount(line.accountCode)
          : undefined;
      return isCostCategory(lineCategory) || automaticCategory
        ? undefined
        : index + 1;
    })
    .filter((index): index is number => index != null);
  if (missingLines.length > 0) {
    errors.push(
      `Selectează categoria de cost pentru ${missingLines.length === 1 ? 'linia' : 'liniile'} ${missingLines.join(', ')}`,
    );
  }

  canonical.lineItems.forEach((line, index) => {
    const explicitCategory = text(line.raw.vehicle_cost_category).toUpperCase();
    const category = isCostCategory(explicitCategory)
      ? explicitCategory
      : defaultVehicleCostCategoryForAccount(line.accountCode);
    if (!category) return;
    const expectedAccount =
      category === CostCategory.TRANSPORT ? '624' : '628';
    if (!new RegExp(`^${expectedAccount}(?:\\.|$)`).test(line.accountCode)) {
      errors.push(
        `Linia ${index + 1} „${line.name}” trebuie să folosească contul ${expectedAccount}`,
      );
    }
  });

  const hasAmbiguousAccounts = canonical.lineItems.some(
    (line) => !defaultVehicleCostCategoryForAccount(line.accountCode),
  );
  if (
    hasAmbiguousAccounts &&
    canonical.raw.vehicle_cost_categories_reviewed !== true
  ) {
    errors.push('Confirmă categoriile de cost înainte de aprobare');
  }
  return errors;
}

export function vehicleAccountingReviewErrors(
  canonical: CanonicalAccountingDocument,
  vehicleId?: number | null,
): string[] {
  const errors = vehiclePurchaseAccountReviewErrors(canonical);
  errors.push(...vehicleCostReviewErrors(canonical, vehicleId));
  return errors;
}

function vehiclePurchaseAccountReviewErrors(
  canonical: CanonicalAccountingDocument,
): string[] {
  if (!isVehiclePurchaseDocument(canonical) || canonical.documentType !== 'Invoice') {
    return [];
  }

  const rawLines = canonical.lineItems.map((line) => line.raw);
  const vehicleLines = new Set(selectVehiclePurchaseLines(rawLines));
  if (vehicleLines.size === 0) {
    return ['Identifică linia mașinii; numai aceasta poate folosi contul 371'];
  }

  const errors: string[] = [];
  canonical.lineItems.forEach((line, index) => {
    const expectedAccount = vehicleLines.has(line.raw)
      ? '371'
      : isFreightInLine(line.raw)
        ? '624'
        : '628';
    if (!new RegExp(`^${expectedAccount}(?:\\.|$)`).test(line.accountCode)) {
      const reason =
        expectedAccount === '371'
          ? 'doar mașina'
          : expectedAccount === '624'
            ? 'transport'
            : 'servicii și taxe asociate';
      errors.push(
        `Linia ${index + 1} „${line.name}” trebuie să folosească contul ${expectedAccount} (${reason})`,
      );
    }
  });
  return errors;
}

/**
 * Finds the vehicle identified by the document, or creates it for a purchase
 * invoice/contract once all required stock-card fields have been extracted.
 */
export async function resolveVehicleFromDocument(
  db: DbClient,
  tenantId: number,
  documentType: string | null | undefined,
  extractedFields: unknown,
  existingVehicleId?: number | null,
): Promise<number | undefined> {
  const candidate = vehicleCandidate(documentType, extractedFields);
  let vehicle = existingVehicleId
    ? await db.vehicle.findFirst({
        where: { id: existingVehicleId, tenantId },
        include: { costs: true },
      })
    : null;
  if (!vehicle && candidate.vin) {
    vehicle = await db.vehicle.findUnique({
      where: { tenantId_vin: { tenantId, vin: candidate.vin } },
      include: { costs: true },
    });
  }

  if (vehicle) {
    const purchasePrice =
      candidate.purchase && candidate.purchasePrice
        ? candidate.purchasePrice
        : Number(vehicle.purchasePrice);
    const update = {
      make: candidate.make || vehicle.make,
      model: candidate.model || vehicle.model,
      variant: candidate.variant || vehicle.variant,
      year: candidate.year || vehicle.year,
      firstRegistered: candidate.firstRegistered || vehicle.firstRegistered,
      mileageKm: candidate.mileageKm ?? vehicle.mileageKm,
      fuelType: candidate.fuelType || vehicle.fuelType,
      color: candidate.color || vehicle.color,
      originCountry: candidate.originCountry || vehicle.originCountry,
      purchasePrice,
      purchaseCurrency:
        candidate.purchase && candidate.purchaseCurrency
          ? candidate.purchaseCurrency
          : vehicle.purchaseCurrency,
      status:
        candidate.purchase && vehicle.status === 'SOURCED'
          ? VehicleStatus.PURCHASED
          : vehicle.status,
      landedCost: round2(
        purchasePrice +
          vehicle.costs.reduce((sum, cost) => sum + Number(cost.amount), 0),
      ),
    };
    await db.vehicle.update({ where: { id: vehicle.id }, data: update });
    await ensureVehicleArticle(db, tenantId, {
      vin: vehicle.vin,
      make: update.make,
      model: update.model,
      variant: update.variant,
    });
    return vehicle.id;
  }

  if (
    !candidate.purchase ||
    !candidate.vin ||
    !candidate.make ||
    !candidate.model ||
    !candidate.year ||
    !candidate.purchasePrice
  ) {
    return undefined;
  }

  const created = await db.vehicle.upsert({
    where: { tenantId_vin: { tenantId, vin: candidate.vin } },
    update: {
      make: candidate.make,
      model: candidate.model,
      variant: candidate.variant,
      year: candidate.year,
      firstRegistered: candidate.firstRegistered,
      mileageKm: candidate.mileageKm,
      fuelType: candidate.fuelType,
      color: candidate.color,
      originCountry: candidate.originCountry || 'RO',
      purchasePrice: candidate.purchasePrice,
      purchaseCurrency: candidate.purchaseCurrency || 'RON',
      status: VehicleStatus.PURCHASED,
      landedCost: candidate.purchasePrice,
    },
    create: {
      tenantId,
      vin: candidate.vin,
      make: candidate.make,
      model: candidate.model,
      variant: candidate.variant,
      year: candidate.year,
      firstRegistered: candidate.firstRegistered,
      mileageKm: candidate.mileageKm,
      fuelType: candidate.fuelType,
      color: candidate.color,
      originCountry: candidate.originCountry || 'RO',
      purchasePrice: candidate.purchasePrice,
      purchaseCurrency: candidate.purchaseCurrency || 'RON',
      status: VehicleStatus.PURCHASED,
      landedCost: candidate.purchasePrice,
    },
    include: { costs: true },
  });
  await ensureVehicleArticle(db, tenantId, created);
  return created.id;
}

/**
 * Mirrors approved incoming accounting documents into the vehicle cost card.
 * Purchase documents set the base price; subsequent invoices and fiscal
 * receipts become categorized landed-cost rows.
 */
export async function syncApprovedDocumentVehicleEffects(
  tx: Prisma.TransactionClient,
  tenantId: number,
  document: {
    id: number;
    name: string;
    type: string | null;
    vehicleId: number | null;
  },
  canonical: CanonicalAccountingDocument,
  isVatPayer: boolean,
  supplierId?: number | null,
  documentExchangeRate = 1,
): Promise<number | undefined> {
  const vehicleId = await resolveVehicleFromDocument(
    tx,
    tenantId,
    document.type,
    canonical.raw,
    document.vehicleId,
  );
  if (!vehicleId) return undefined;

  if (document.vehicleId !== vehicleId) {
    await tx.document.update({
      where: { id: document.id },
      data: { vehicleId },
    });
  }

  if (isVehiclePurchaseDocument(canonical)) {
    const purchasePrice =
      canonical.documentType === 'Invoice'
        ? economicDocumentAmount(canonical, isVatPayer)
        : canonical.totalAmount;
    await tx.vehicle.update({
      where: { id: vehicleId },
      data: {
        purchasePrice,
        purchaseCurrency: canonical.currency,
        status: VehicleStatus.PURCHASED,
        sellerId: supplierId || undefined,
      },
    });
    await tx.vehicleCost.deleteMany({
      where: { documentId: document.id, autoGenerated: true },
    });
    await recomputeVehicleLandedCost(tx, vehicleId);
    return vehicleId;
  }

  const eligibleCostDocument =
    ['Invoice', 'Receipt'].includes(canonical.documentType) &&
    canonical.direction === 'incoming' &&
    canonical.receiptType !== 'payment_receipt';
  if (!eligibleCostDocument) return vehicleId;

  await tx.vehicleCost.deleteMany({
    where: { documentId: document.id, autoGenerated: true },
  });
  const grouped = groupVehicleCosts(canonical, isVatPayer);
  const vehicle = await tx.vehicle.findUnique({
    where: { id: vehicleId },
    select: { purchaseCurrency: true },
  });
  if (!vehicle) return vehicleId;
  for (const [category, amount] of grouped) {
    if (amount <= 0) continue;
    const normalizedAmount = await convertCostToPurchaseCurrency(
      tx,
      tenantId,
      vehicleId,
      amount,
      canonical,
      documentExchangeRate,
      vehicle.purchaseCurrency,
    );
    await tx.vehicleCost.create({
      data: {
        vehicleId,
        documentId: document.id,
        category,
        amount: normalizedAmount,
        currency: vehicle.purchaseCurrency,
        note:
          canonical.currency === vehicle.purchaseCurrency
            ? `Generat din ${document.name}`
            : `Generat din ${document.name} · ${amount.toFixed(2)} ${canonical.currency}`,
        autoGenerated: true,
      },
    });
  }
  await recomputeVehicleLandedCost(tx, vehicleId);
  return vehicleId;
}

async function convertCostToPurchaseCurrency(
  tx: Prisma.TransactionClient,
  tenantId: number,
  vehicleId: number,
  amount: number,
  canonical: CanonicalAccountingDocument,
  documentExchangeRate: number,
  purchaseCurrency: string,
): Promise<number> {
  if (canonical.currency === purchaseCurrency) return amount;
  const sourceRate =
    canonical.currency === 'RON' ? 1 : documentExchangeRate;
  if (purchaseCurrency === 'RON') return round2(amount * sourceRate);

  const purchasePosting = await tx.generalLedgerEntry.findFirst({
    where: {
      tenantId,
      currency: purchaseCurrency,
      sourceType: { in: ['INVOICE_IN', 'CONTRACT_PURCHASE'] },
      document: { is: { vehicleId } },
    },
    orderBy: { postingDate: 'asc' },
    select: { exchangeRate: true },
  });
  const purchaseRate = purchasePosting
    ? Number(purchasePosting.exchangeRate)
    : await resolveExchangeRateToRon({
        ...canonical,
        currency: purchaseCurrency,
        exchangeRate: undefined,
      });
  return round2((amount * sourceRate) / purchaseRate);
}

export async function removeDocumentVehicleCosts(
  tx: Prisma.TransactionClient,
  documentId: number,
): Promise<void> {
  const affected = await tx.vehicleCost.findMany({
    where: { documentId, autoGenerated: true },
    select: { vehicleId: true },
    distinct: ['vehicleId'],
  });
  await tx.vehicleCost.deleteMany({
    where: { documentId, autoGenerated: true },
  });
  for (const { vehicleId } of affected) {
    await recomputeVehicleLandedCost(tx, vehicleId);
  }
}

export async function recomputeVehicleLandedCost(
  tx: Prisma.TransactionClient,
  vehicleId: number,
): Promise<void> {
  const vehicle = await tx.vehicle.findUnique({
    where: { id: vehicleId },
    include: { costs: true },
  });
  if (!vehicle) return;
  const landed = round2(
    Number(vehicle.purchasePrice) +
      vehicle.costs.reduce((sum, cost) => sum + Number(cost.amount), 0),
  );
  await tx.vehicle.update({
    where: { id: vehicleId },
    data: { landedCost: landed },
  });
}

function vehicleCandidate(
  documentType: string | null | undefined,
  extractedFields: unknown,
): VehicleCandidate {
  const raw = unwrapExtractedFields(extractedFields);
  const firstRegistered = dateValue(
    raw.first_registration_date ?? raw.firstRegistered,
  );
  const vin = normalizeVin(raw.vin ?? raw.vehicle_vin ?? raw.chassis_number);
  const purchase =
    isRawPurchase(documentType, raw) &&
    text(raw.direction).toLowerCase() !== 'outgoing';
  const total = numberValue(
    raw.total_amount ?? raw.total_value ?? raw.grand_total ?? raw.total,
  );
  return {
    vin,
    make: optionalText(raw.vehicle_make ?? raw.make),
    model: optionalText(raw.vehicle_model ?? raw.model),
    variant: optionalText(raw.vehicle_variant ?? raw.variant),
    year:
      integerValue(raw.vehicle_year ?? raw.year) ??
      firstRegistered?.getUTCFullYear() ??
      inferYear(raw.vehicle_model ?? raw.model ?? raw.description),
    firstRegistered,
    mileageKm: integerValue(raw.mileage_km ?? raw.mileage),
    fuelType: optionalText(raw.fuel_type),
    color: optionalText(raw.color),
    originCountry: (
      optionalText(raw.vehicle_origin_country) ??
      optionalText(raw.origin_country) ??
      optionalText(raw.vendor_country) ??
      optionalText(raw.supplier_country) ??
      optionalText(contractVendorCountry(raw))
    )?.toUpperCase(),
    purchasePrice: purchase && total > 0 ? total : undefined,
    purchaseCurrency: optionalText(raw.currency)?.toUpperCase(),
    purchase,
  };
}

function isRawPurchase(
  documentType: string | null | undefined,
  raw: Record<string, any>,
): boolean {
  const transaction = text(raw.vehicle_transaction).toLowerCase();
  if (transaction === 'purchase') return true;
  if (transaction === 'cost' || transaction === 'other') return false;
  if (documentType === 'Contract') {
    const type = text(raw.contract_type).toLowerCase();
    return Boolean(
      normalizeVin(raw.vin) &&
        (type.includes('vanzare') ||
          type.includes('vânzare') ||
          type.includes('sale') ||
          type.includes('achiz')),
    );
  }
  if (documentType !== 'Invoice' || !normalizeVin(raw.vin)) return false;
  const lines = Array.isArray(raw.line_items) ? raw.line_items : [];
  return lines.some((line: Record<string, any>) => {
    const account = text(line?.account_code ?? line?.accountCode);
    const name = text(line?.name ?? line?.description);
    return /^371/.test(account) || /\b(auto|autoturism|vehicle|vehicul|fahrzeug)\b/i.test(name);
  });
}

function groupVehicleCosts(
  canonical: CanonicalAccountingDocument,
  isVatPayer: boolean,
): Map<CostCategory, number> {
  const grouped = new Map<CostCategory, number>();
  const lines =
    canonical.lineItems.length > 0
      ? canonical.lineItems
      : [
          {
            name: 'Cost conform documentului',
            netAmount: canonical.netAmount,
            vatAmount: canonical.vatAmount,
            accountCode: canonical.accountCode || '',
            vatDeductibility: 'FULL',
            raw: {},
          } as CanonicalLineItem,
        ];
  for (const line of lines) {
    const amount = economicLineAmount(
      line,
      canonical,
      isVatPayer,
    );
    const category = vehicleCostCategory(line);
    grouped.set(category, round2((grouped.get(category) ?? 0) + amount));
  }
  return grouped;
}

function economicDocumentAmount(
  canonical: CanonicalAccountingDocument,
  isVatPayer: boolean,
): number {
  if (canonical.lineItems.length === 0) {
    return isVatPayer ? canonical.netAmount : canonical.totalAmount;
  }
  return round2(
    canonical.lineItems.reduce(
      (sum, line) =>
        sum + economicLineAmount(line, canonical, isVatPayer),
      0,
    ),
  );
}

function economicLineAmount(
  line: CanonicalLineItem,
  canonical: CanonicalAccountingDocument,
  isVatPayer: boolean,
): number {
  const lineVat =
    line.vatAmount ||
    (canonical.vatAmount > 0 && canonical.netAmount > 0
      ? (canonical.vatAmount * line.netAmount) / canonical.netAmount
      : 0);
  let nonDeductibleVat = lineVat;
  if (isVatPayer && line.vatDeductibility === 'FULL') {
    nonDeductibleVat = 0;
  } else if (isVatPayer && line.vatDeductibility === 'PARTIAL_50') {
    nonDeductibleVat = lineVat / 2;
  }
  return round2(line.netAmount + nonDeductibleVat);
}

function vehicleCostCategory(line: CanonicalLineItem): CostCategory {
  const explicit = text(line.raw.vehicle_cost_category).toUpperCase();
  if (isCostCategory(explicit)) return explicit;
  const automatic = defaultVehicleCostCategoryForAccount(line.accountCode);
  if (automatic) return automatic;
  if (/^4426/.test(line.accountCode)) return CostCategory.VAT;
  const value = `${line.name} ${line.accountCode}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  if (/\b(transport|freight|platforma|tractare|tow)\b/.test(value)) {
    return CostCategory.TRANSPORT;
  }
  if (/\b(vama|vamal|customs|duty)\b/.test(value)) return CostCategory.CUSTOMS;
  if (/\b(tva|vat)\b/.test(value)) return CostCategory.VAT;
  if (/\b(itp|tuv|inspection|inspectie)\b/.test(value)) return CostCategory.ITP;
  if (/\b(inmatriculare|registration|rar|numere)\b/.test(value)) {
    return CostCategory.REGISTRATION;
  }
  if (
    /\b(reparatie|repair|service|refurb|recondition|piese|parts|anvelope|vopsitorie)\b/.test(
      value,
    )
  ) {
    return CostCategory.REFURB;
  }
  return CostCategory.OTHER;
}

export function defaultVehicleCostCategoryForAccount(
  accountCode: unknown,
): CostCategory | undefined {
  const account = text(accountCode);
  if (/^624/.test(account)) return CostCategory.TRANSPORT;
  return undefined;
}

function isCostCategory(value: string): value is CostCategory {
  return [
    'TRANSPORT',
    'CUSTOMS',
    'VAT',
    'ITP',
    'REGISTRATION',
    'REFURB',
    'OTHER',
  ].includes(value);
}

function contractVendorCountry(raw: Record<string, any>): string | undefined {
  if (!Array.isArray(raw.parties)) return undefined;
  const vendor = raw.parties.find(
    (party: Record<string, any>) =>
      text(party?.role).toLowerCase() === 'vendor',
  );
  return optionalText(vendor?.country);
}

function normalizeVin(value: unknown): string | undefined {
  const vin = text(value).toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : undefined;
}

function dateValue(value: unknown): Date | undefined {
  const normalized = normalizeDate(value);
  return normalized ? new Date(`${normalized}T12:00:00.000Z`) : undefined;
}

function inferYear(value: unknown): number | undefined {
  const match = text(value).match(/\b(19[89]\d|20[0-3]\d)\b/);
  return match ? Number(match[1]) : undefined;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(text(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function integerValue(value: unknown): number | undefined {
  const number = numberValue(value);
  return number > 0 ? Math.round(number) : undefined;
}

function optionalText(value: unknown): string | undefined {
  return text(value) || undefined;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}
