import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GeneralLedgerEntry, Party } from '@prisma/client';
import JSZip from 'jszip';
import {
  CanonicalAccountingDocument,
  isVehiclePurchaseContract,
  normalizeAccountingDocument,
  normalizeEin,
} from '../accounting/accounting-normalizer';
import { isVehiclePurchaseDocument } from '../vehicles/vehicle-document-sync';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import {
  buildArticlesXml,
  buildFacturiXml,
  buildIncasariXml,
  buildPartnersXml,
  buildPlatiXml,
  SagaArticleRecord,
  SagaCompany,
  SagaInvoiceRecord,
  SagaMovement,
  SagaPartnerRecord,
} from './saga-xml';

export const SAGA_EXPORT_TYPES = [
  'facturi',
  'incasari',
  'plati',
  'furnizori',
  'clienti',
  'articole',
] as const;

export type SagaExportType = (typeof SAGA_EXPORT_TYPES)[number];

export interface SagaExportRequest {
  from?: string;
  to?: string;
  types?: SagaExportType[];
  preset?: string;
}

interface CollectedSagaData {
  tenant: {
    cui: string | null;
    name: string;
    registrationNumber: string | null;
    address: string | null;
    country: string;
    county: string | null;
    city: string | null;
    iban: string | null;
    bankName: string | null;
    email: string | null;
    phone: string | null;
    isVatPayer: boolean;
    hasTvaLaIncasare: boolean;
    accountingCutoverAt: Date;
  };
  from: string;
  to: string;
  types: SagaExportType[];
  invoices: SagaInvoiceRecord[];
  receipts: SagaMovement[];
  payments: SagaMovement[];
  suppliers: SagaPartnerRecord[];
  clients: SagaPartnerRecord[];
  articles: SagaArticleRecord[];
  excluded: Array<{ id: number; name: string; reason: string }>;
  blockingErrors: string[];
}

@Injectable()
export class SagaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async preview(tenantId: number, request: SagaExportRequest) {
    const data = await this.collect(tenantId, request);
    const counts = this.counts(data);
    return {
      from: data.from,
      to: data.to,
      cutoverAt: data.tenant.accountingCutoverAt,
      selectedTypes: data.types,
      counts,
      files: data.types.map((type) => ({
        type,
        rows: counts[type],
        included: counts[type] > 0,
        reason:
          counts[type] > 0
            ? undefined
            : 'Fișierul va fi omis deoarece nu are înregistrări',
      })),
      excluded: data.excluded,
      excludedCount: data.excluded.length,
      blockingErrors: data.blockingErrors,
      canExport: data.blockingErrors.length === 0,
    };
  }

  async getPreferences(tenantId: number): Promise<SagaExportRequest | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { sagaExportConfig: true },
    });
    if (!tenant) throw new NotFoundException('Compania nu a fost găsită');
    if (!tenant.sagaExportConfig) return null;
    return normalizePreference(tenant.sagaExportConfig);
  }

  async savePreferences(
    tenantId: number,
    request: SagaExportRequest,
  ): Promise<SagaExportRequest> {
    const preference = normalizePreference(request);
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { sagaExportConfig: preference as any },
    });
    return preference;
  }

  async exportZip(
    tenantId: number,
    userId: number,
    request: SagaExportRequest,
  ): Promise<{ content: Buffer; fileName: string; fileCount: number }> {
    const data = await this.collect(tenantId, request);
    if (data.blockingErrors.length > 0) {
      throw new BadRequestException({
        message: 'Exportul SAGA conține erori care trebuie corectate',
        errors: data.blockingErrors,
      });
    }

    const zip = new JSZip();
    const stamp = new Date().toISOString().slice(0, 10);
    const company: SagaCompany = {
      cui: data.tenant.cui,
      name: data.tenant.name,
      registrationNumber: data.tenant.registrationNumber,
      address: data.tenant.address,
      country: data.tenant.country,
      county: data.tenant.county,
      city: data.tenant.city,
      iban: data.tenant.iban,
      bankName: data.tenant.bankName,
      email: data.tenant.email,
      phone: data.tenant.phone,
      isVatPayer: data.tenant.isVatPayer,
      hasTvaLaIncasare: data.tenant.hasTvaLaIncasare,
    };
    let fileCount = 0;
    const add = (name: string, rows: unknown[], contents: () => string) => {
      if (rows.length === 0) return;
      zip.file(name, contents());
      fileCount += 1;
    };

    if (data.types.includes('facturi')) {
      add(
        sagaInvoicesFileName(data.tenant.cui, stamp),
        data.invoices,
        () => buildFacturiXml(data.invoices, company, data.articles),
      );
    }
    if (data.types.includes('incasari')) {
      add(`I_${stamp}.xml`, data.receipts, () =>
        buildIncasariXml(data.receipts),
      );
    }
    if (data.types.includes('plati')) {
      add(`P_${stamp}.xml`, data.payments, () => buildPlatiXml(data.payments));
    }
    if (data.types.includes('furnizori')) {
      add(`FUR_${stamp}.xml`, data.suppliers, () =>
        buildPartnersXml('Furnizori', data.suppliers),
      );
    }
    if (data.types.includes('clienti')) {
      add(`CLI_${stamp}.xml`, data.clients, () =>
        buildPartnersXml('Clienti', data.clients),
      );
    }
    if (data.types.includes('articole')) {
      add(`ART_${stamp}.xml`, data.articles, () =>
        buildArticlesXml(data.articles),
      );
    }

    if (fileCount === 0) {
      throw new BadRequestException(
        'Nu există înregistrări pentru tipurile și perioada selectate',
      );
    }
    const content = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.zip_exported',
      entity: 'GeneralLedgerEntry',
      details: {
        from: data.from,
        to: data.to,
        types: data.types,
        counts: this.counts(data),
        fileCount,
      },
    });
    await this.savePreferences(tenantId, {
      from: data.from,
      to: data.to,
      types: data.types,
      preset: request.preset,
    });
    return {
      content,
      fileName: `SAGA_Export_${stamp}.zip`,
      fileCount,
    };
  }

  /**
   * Compatibility endpoint retained while consumers move to the ZIP wizard.
   * It now uses the canonical fields and the same approval/cutover rules.
   */
  async export(
    tenantId: number,
    userId: number,
    format: 'xml' | 'csv',
    from?: string,
    to?: string,
  ): Promise<{ content: string; fileName: string; contentType: string; count: number }> {
    const data = await this.collect(tenantId, {
      from,
      to,
      types: ['facturi'],
    });
    if (data.invoices.length === 0) {
      throw new BadRequestException(
        'Nicio factură aprobată în intervalul ales',
      );
    }
    const stamp = `${data.from}_${data.to}`;
    const content =
      format === 'csv'
        ? buildCompatibilityCsv(data.invoices)
        : buildFacturiXml(
            data.invoices,
            {
              cui: data.tenant.cui,
              name: data.tenant.name,
              registrationNumber: data.tenant.registrationNumber,
              address: data.tenant.address,
              country: data.tenant.country,
              county: data.tenant.county,
              city: data.tenant.city,
              iban: data.tenant.iban,
              bankName: data.tenant.bankName,
              email: data.tenant.email,
              phone: data.tenant.phone,
              isVatPayer: data.tenant.isVatPayer,
              hasTvaLaIncasare: data.tenant.hasTvaLaIncasare,
            },
            data.articles,
          );
    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.compatibility_exported',
      entity: 'Document',
      details: { format, from: data.from, to: data.to, count: data.invoices.length },
    });
    return {
      content,
      fileName: `saga_facturi_${stamp}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/xml; charset=utf-8',
      count: data.invoices.length,
    };
  }

  async exportPartners(
    tenantId: number,
    userId: number,
    tip: 'clienti' | 'furnizori',
  ): Promise<{ content: string; fileName: string; contentType: string; count: number }> {
    const data = await this.collect(tenantId, {
      types: [tip],
    });
    const partners = tip === 'furnizori' ? data.suppliers : data.clients;
    if (partners.length === 0) {
      throw new BadRequestException(
        'Niciun partener de exportat pentru categoria aleasă',
      );
    }
    await this.audit.log({
      tenantId,
      userId,
      action: 'saga.compatibility_exported',
      entity: 'Party',
      details: { tip, count: partners.length },
    });
    return {
      content: buildPartnersXml(
        tip === 'furnizori' ? 'Furnizori' : 'Clienti',
        partners,
      ),
      fileName: `saga_${tip}.xml`,
      contentType: 'application/xml; charset=utf-8',
      count: partners.length,
    };
  }

  private async collect(
    tenantId: number,
    request: SagaExportRequest,
  ): Promise<CollectedSagaData> {
    const { from, to } = normalizeRange(request.from, request.to);
    const types = normalizeTypes(request.types);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        cui: true,
        name: true,
        registrationNumber: true,
        address: true,
        country: true,
        county: true,
        city: true,
        iban: true,
        bankName: true,
        email: true,
        phone: true,
        isVatPayer: true,
        hasTvaLaIncasare: true,
        accountingCutoverAt: true,
      },
    });
    if (!tenant) throw new NotFoundException('Compania nu a fost găsită');

    const [approvedDocuments, nonExportableDocuments, ledgerEntries, parties, articles] =
      await Promise.all([
        this.prisma.document.findMany({
          where: {
            tenantId,
            deletedAt: null,
            archivedAt: null,
            reviewStatus: 'APPROVED',
            uploadedAt: { gte: tenant.accountingCutoverAt },
            type: {
              in: [
                'Invoice',
                'Contract',
                'Receipt',
                'Payment Disposition',
                'Collection Disposition',
              ],
            },
          },
          include: {
            processedData: true,
            childLinks: {
              where: { relation: 'payment' },
              include: {
                parent: {
                  include: { processedData: true },
                },
              },
            },
          },
          orderBy: { uploadedAt: 'asc' },
        }),
        this.prisma.document.findMany({
          where: {
            tenantId,
            deletedAt: null,
            archivedAt: null,
            OR: [
              { uploadedAt: { lt: tenant.accountingCutoverAt } },
              {
                reviewStatus: {
                  in: ['LEGACY', 'PENDING_APPROVAL', 'REOPENED'],
                },
              },
              { postingStatus: 'ERROR' },
            ],
          },
          select: {
            id: true,
            name: true,
            type: true,
            reviewStatus: true,
            postingStatus: true,
            postingError: true,
            uploadedAt: true,
            processedData: { select: { extractedFields: true } },
          },
          orderBy: { uploadedAt: 'desc' },
          take: 200,
        }),
        this.prisma.generalLedgerEntry.findMany({
          where: {
            tenantId,
            postingDate: {
              gte: new Date(`${from}T00:00:00.000Z`),
              lte: new Date(`${to}T23:59:59.999Z`),
            },
            document: {
              is: {
                reviewStatus: 'APPROVED',
                uploadedAt: { gte: tenant.accountingCutoverAt },
                deletedAt: null,
                archivedAt: null,
              },
            },
          },
          include: {
            document: {
              include: {
                processedData: true,
                childLinks: {
                  where: { relation: 'payment' },
                  include: {
                    parent: { include: { processedData: true } },
                  },
                },
              },
            },
          },
          orderBy: [{ postingDate: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.party.findMany({
          where: { tenantId },
          orderBy: { name: 'asc' },
        }),
        this.prisma.article.findMany({
          where: { tenantId },
          orderBy: [{ code: 'asc' }, { name: 'asc' }],
        }),
      ]);

    const invoices: SagaInvoiceRecord[] = [];
    for (const document of approvedDocuments) {
      if (!document.processedData) continue;
      const data = normalizeAccountingDocument(
        document.type,
        document.processedData.extractedFields,
        tenant.cui,
      );
      if (!data.documentDate || !inRange(data.documentDate, from, to)) continue;
      const independentReceipt =
        document.type === 'Receipt' &&
        data.receiptType !== 'payment_receipt' &&
        data.referencedNumbers.length === 0;
      const purchaseContract = isVehiclePurchaseContract(data);
      if (document.type === 'Invoice' || independentReceipt || purchaseContract) {
        invoices.push({
          id: document.id,
          type: document.type,
          vehicleId: document.vehicleId,
          data,
        });
      }
    }
    sortInvoicesByCar(invoices);

    const movements = movementsFromLedger(ledgerEntries, tenant.cui);
    const suppliers = parties
      .filter((party) => party.isSupplier)
      .map((party) =>
        partnerRecord(
          party,
          'supplier',
          tenant,
          findPartnerDocument(invoices, party, 'supplier'),
        ),
      );
    const clients = parties
      .filter((party) => party.isClient)
      .map((party) =>
        partnerRecord(
          party,
          'client',
          tenant,
          findPartnerDocument(invoices, party, 'client'),
        ),
      );
    const referencedArticleCodes = new Set(
      invoices.flatMap((invoice) =>
        invoice.data.lineItems.map((line) => line.articleCode).filter(Boolean),
      ),
    );
    const orphanedVehicleCostArticleCodes = new Set(
      invoices
        .filter(
          (invoice) =>
            invoice.data.documentType === 'Invoice' &&
            String(invoice.data.raw.vehicle_transaction).toLowerCase() === 'cost',
        )
        .flatMap((invoice) =>
          invoice.data.lineItems
            .map((line) =>
              String(
                line.raw.articleCode ??
                  line.raw.article_code ??
                  line.raw.cod_articol_client ??
                  '',
              ).trim(),
            )
            .filter(Boolean),
        ),
    );
    const articleRecords: SagaArticleRecord[] = articles
      .filter(
        (article) =>
          !orphanedVehicleCostArticleCodes.has(article.code) ||
          referencedArticleCodes.has(article.code),
      )
      .map((article) => ({
        code: article.code,
        name: article.name,
        analyticCode: article.analyticCode,
        vatRate: article.vatRate,
        unit: article.unit,
        type: article.type,
      }));
    const relevantNonExportableDocuments = nonExportableDocuments.filter(
      (document) => {
        const data = document.processedData
          ? normalizeAccountingDocument(
              document.type,
              document.processedData.extractedFields,
              tenant.cui,
            )
          : undefined;
        const effectiveDate =
          data?.documentDate ?? document.uploadedAt.toISOString().slice(0, 10);
        return inRange(effectiveDate, from, to);
      },
    );
    const excluded = relevantNonExportableDocuments.map((document) => ({
      id: document.id,
      name: document.name,
      reason:
        document.uploadedAt < tenant.accountingCutoverAt ||
        document.reviewStatus === 'LEGACY'
          ? 'Document istoric, anterior datei de activare'
          : document.postingStatus === 'ERROR'
            ? `Eroare la postare: ${document.postingError || 'detalii indisponibile'}`
            : document.reviewStatus === 'REOPENED'
              ? 'Document redeschis și neaprobat'
              : 'În așteptarea aprobării',
    }));
    const blockingErrors: string[] = [];
    if (types.includes('facturi') && !tenant.cui) {
      blockingErrors.push(
        'Completează CUI-ul companiei în Setări înainte de exportul facturilor',
      );
    }
    for (const document of relevantNonExportableDocuments) {
      if (document.postingStatus === 'ERROR' && document.postingError) {
        blockingErrors.push(`${document.name}: ${document.postingError}`);
      }
    }

    return {
      tenant,
      from,
      to,
      types,
      invoices,
      receipts: movements.receipts,
      payments: movements.payments,
      suppliers,
      clients,
      articles: articleRecords.filter((article) => article.analyticCode),
      excluded,
      blockingErrors: Array.from(new Set(blockingErrors)),
    };
  }

  private counts(data: CollectedSagaData): Record<SagaExportType, number> {
    return {
      facturi: data.invoices.length,
      incasari: data.receipts.length,
      plati: data.payments.length,
      furnizori: data.suppliers.length,
      clienti: data.clients.length,
      articole: data.articles.length,
    };
  }
}

function normalizePreference(value: unknown): SagaExportRequest {
  const object =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const { from, to } = normalizeRange(
    typeof object.from === 'string' ? object.from : undefined,
    typeof object.to === 'string' ? object.to : undefined,
  );
  return {
    from,
    to,
    types: normalizeTypes(
      Array.isArray(object.types) ? (object.types as SagaExportType[]) : undefined,
    ),
    preset: typeof object.preset === 'string' ? object.preset : 'custom',
  };
}

type LedgerWithDocument = GeneralLedgerEntry & {
  document: {
    id: number;
    name: string;
    type: string | null;
    processedData: { extractedFields: unknown } | null;
    childLinks: Array<{
      paymentAmount: unknown;
      parent: {
        id: number;
        type: string | null;
        processedData: { extractedFields: unknown } | null;
      };
    }>;
  } | null;
};

function movementsFromLedger(
  entries: LedgerWithDocument[],
  tenantCui: string | null,
): { receipts: SagaMovement[]; payments: SagaMovement[] } {
  const byDocument = new Map<number, LedgerWithDocument[]>();
  for (const entry of entries) {
    if (!entry.documentId || !entry.document) continue;
    const group = byDocument.get(entry.documentId) ?? [];
    group.push(entry);
    byDocument.set(entry.documentId, group);
  }
  const receipts: SagaMovement[] = [];
  const payments: SagaMovement[] = [];
  for (const [documentId, group] of byDocument) {
    const document = group[0].document!;
    if (!document.processedData) continue;
    const canonical = normalizeAccountingDocument(
      document.type,
      document.processedData.extractedFields,
      tenantCui,
    );
    const references = document.childLinks.filter(
      (link) => link.parent.processedData,
    );

    for (const liquidity of group.filter((entry) =>
      /^(5311|5121|5124)/.test(entry.accountCode),
    )) {
      const debit = Number(liquidity.debit);
      const credit = Number(liquidity.credit);
      if (debit <= 0 && credit <= 0) continue;
      const isReceipt = debit > 0;
      const counterpart =
        group.find((entry) =>
          isReceipt
            ? /^411/.test(entry.accountCode)
            : /^401/.test(entry.accountCode),
        ) ??
        group
          .filter(
            (entry) =>
              entry.id !== liquidity.id &&
              !/^(4426|4427|5311|5121|5124)/.test(entry.accountCode),
          )
          .sort(
            (a, b) =>
              Number(b.debit) +
              Number(b.credit) -
              Number(a.debit) -
              Number(a.credit),
          )[0];
      const targets = references.length > 0 ? references : [undefined];
      for (const target of targets) {
        const referencedCanonical = target?.parent.processedData
          ? normalizeAccountingDocument(
              target.parent.type,
              target.parent.processedData.extractedFields,
              tenantCui,
            )
          : undefined;
        const movement: SagaMovement = {
          date: liquidity.postingDate.toISOString().slice(0, 10),
          reference:
            liquidity.reference || canonical.documentNumber || document.name,
          amount:
            target?.paymentAmount != null
              ? Number(target.paymentAmount)
              : liquidity.originalAmount != null
                ? Number(liquidity.originalAmount)
                : isReceipt
                  ? debit
                  : credit,
          accountCode: liquidity.accountCode,
          counterAccount: counterpart?.accountCode || '',
          description:
            liquidity.description ||
            (isReceipt
              ? 'Încasare conform documentului'
              : 'Plată conform documentului'),
          currency: liquidity.currency || 'RON',
          sourceType: liquidity.sourceType,
          documentId: target?.parent.id ?? documentId,
          invoiceNumber:
            referencedCanonical?.documentNumber || canonical.documentNumber,
        };
        (isReceipt ? receipts : payments).push(movement);
      }
    }
  }
  return { receipts, payments };
}

function partnerRecord(
  party: Party,
  role: 'supplier' | 'client',
  tenant: CollectedSagaData['tenant'],
  document?: CanonicalAccountingDocument,
): SagaPartnerRecord {
  const supplier = role === 'supplier';
  const partyTaxId = normalizeEin(party.taxId);
  const ownCompany = Boolean(
    partyTaxId && partyTaxId === normalizeEin(tenant.cui),
  );
  const extracted = documentPartnerRecord(document, role);
  return {
    name: party.name,
    taxId: party.taxId,
    country:
      party.country || extracted.country || (ownCompany ? tenant.country : null),
    county:
      party.county || extracted.county || (ownCompany ? tenant.county : null),
    city: party.city || extracted.city || (ownCompany ? tenant.city : null),
    address:
      party.address || extracted.address || (ownCompany ? tenant.address : null),
    iban: party.iban || extracted.iban || (ownCompany ? tenant.iban : null),
    bankName:
      party.bankName ||
      extracted.bankName ||
      (ownCompany ? tenant.bankName : null),
    phone: party.phone || extracted.phone || (ownCompany ? tenant.phone : null),
    email: party.email || extracted.email || (ownCompany ? tenant.email : null),
    registration:
      party.registration ||
      extracted.registration ||
      (ownCompany ? tenant.registrationNumber : null),
    discount: party.discount,
    code: supplier ? party.supplierCode : party.clientCode,
    analytic: supplier ? party.supplierAnalytic : party.clientAnalytic,
  };
}

function findPartnerDocument(
  invoices: SagaInvoiceRecord[],
  party: Party,
  role: 'supplier' | 'client',
): CanonicalAccountingDocument | undefined {
  const partyTaxId = normalizeEin(party.taxId);
  const partyName = party.name.trim().toLowerCase();
  return invoices
    .map((invoice) => invoice.data)
    .find((data) => {
      const taxId = normalizeEin(
        role === 'supplier' ? data.vendorEin : data.buyerEin,
      );
      const name = (role === 'supplier' ? data.vendor : data.buyer)
        .trim()
        .toLowerCase();
      return partyTaxId
        ? taxId === partyTaxId
        : Boolean(partyName && name === partyName);
    });
}

function documentPartnerRecord(
  document: CanonicalAccountingDocument | undefined,
  role: 'supplier' | 'client',
): SagaPartnerRecord {
  if (!document) return { name: '' };
  return role === 'supplier'
    ? {
        name: document.vendor,
        taxId: document.vendorEin,
        registration: document.vendorRegistration,
        country: document.vendorCountry,
        county: document.vendorCounty,
        city: document.vendorCity,
        address: document.vendorAddress,
        iban: document.vendorIban,
        bankName: document.vendorBankName,
        phone: document.vendorPhone,
        email: document.vendorEmail,
      }
    : {
        name: document.buyer,
        taxId: document.buyerEin,
        registration: document.buyerRegistration,
        country: document.buyerCountry,
        county: document.buyerCounty,
        city: document.buyerCity,
        address: document.buyerAddress,
        iban: document.buyerIban,
        bankName: document.buyerBankName,
        phone: document.buyerPhone,
        email: document.buyerEmail,
      };
}

function normalizeTypes(types?: SagaExportType[]): SagaExportType[] {
  if (!Array.isArray(types) || types.length === 0) return [...SAGA_EXPORT_TYPES];
  const normalized = types.filter((type): type is SagaExportType =>
    SAGA_EXPORT_TYPES.includes(type as SagaExportType),
  );
  if (normalized.length === 0) {
    throw new BadRequestException('Selectează cel puțin un tip de export');
  }
  return Array.from(new Set(normalized));
}

function normalizeRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const defaultTo = now.toISOString().slice(0, 10);
  const defaultFrom = `${defaultTo.slice(0, 8)}01`;
  const normalizedFrom = validIsoDate(from) ? from! : defaultFrom;
  const normalizedTo = validIsoDate(to) ? to! : defaultTo;
  if (normalizedFrom > normalizedTo) {
    throw new BadRequestException(
      'Data de început trebuie să fie înaintea datei de sfârșit',
    );
  }
  return { from: normalizedFrom, to: normalizedTo };
}

function validIsoDate(value?: string): boolean {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function inRange(value: string, from: string, to: string): boolean {
  return value >= from && value <= to;
}

type InvoiceKind = 'car' | 'services' | 'transport';

const INVOICE_KIND_RANK: Record<InvoiceKind, number> = {
  car: 0,
  services: 1,
  transport: 2,
};

/**
 * Classify an export document relative to a car. The dealership's convention
 * (see vehicle-document-sync) posts the car itself as a 371 stock purchase,
 * transport to 624 and every other ancillary service to 628 — so the car
 * purchase wins first, then anything carrying a 624 line is transport, and
 * whatever remains is a service.
 */
function classifyInvoice(record: SagaInvoiceRecord): InvoiceKind {
  if (isVehiclePurchaseDocument(record.data)) return 'car';
  const hasFreight = record.data.lineItems.some((line) =>
    /^624/.test(line.accountCode),
  );
  return hasFreight ? 'transport' : 'services';
}

/** VIN a car purchase belongs to, so it groups even before a Vehicle link exists. */
function invoiceVin(record: SagaInvoiceRecord): string {
  const raw = record.data.raw;
  return String(raw.vin ?? raw.vehicle_vin ?? raw.chassis_number ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Order the export car-by-car: each car's own purchase first, then its
 * services, then its transport, before the next car. Cars are ordered by
 * purchase date; documents not tied to any car keep chronological order at the
 * very end. Sorts in place so every export (XML + CSV) inherits the layout.
 */
function sortInvoicesByCar(invoices: SagaInvoiceRecord[]): void {
  const dateOf = (record: SagaInvoiceRecord) =>
    record.data.documentDate || '9999-12-31';
  const originalIndex = new Map(invoices.map((record, index) => [record, index]));

  const kind = new Map<SagaInvoiceRecord, InvoiceKind>();
  const groupKey = new Map<SagaInvoiceRecord, string | null>();
  for (const record of invoices) {
    const recordKind = classifyInvoice(record);
    kind.set(record, recordKind);
    if (record.vehicleId != null) {
      groupKey.set(record, `v:${record.vehicleId}`);
    } else if (recordKind === 'car' && invoiceVin(record)) {
      groupKey.set(record, `vin:${invoiceVin(record)}`);
    } else {
      groupKey.set(record, null);
    }
  }

  const groups = new Map<string, SagaInvoiceRecord[]>();
  const ungrouped: SagaInvoiceRecord[] = [];
  for (const record of invoices) {
    const key = groupKey.get(record);
    if (key == null) {
      ungrouped.push(record);
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }

  const byIndex = (a: SagaInvoiceRecord, b: SagaInvoiceRecord) =>
    originalIndex.get(a)! - originalIndex.get(b)!;
  const withinGroup = (a: SagaInvoiceRecord, b: SagaInvoiceRecord) =>
    INVOICE_KIND_RANK[kind.get(a)!] - INVOICE_KIND_RANK[kind.get(b)!] ||
    dateOf(a).localeCompare(dateOf(b)) ||
    byIndex(a, b);

  const orderedGroups = [...groups.values()]
    .map((records) => {
      const sorted = [...records].sort(withinGroup);
      const car = sorted.find((record) => kind.get(record) === 'car');
      const date = car
        ? dateOf(car)
        : sorted.reduce(
            (min, record) => (dateOf(record) < min ? dateOf(record) : min),
            '9999-12-31',
          );
      return { records: sorted, date };
    })
    .sort(
      (a, b) => a.date.localeCompare(b.date) || byIndex(a.records[0], b.records[0]),
    );

  ungrouped.sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || byIndex(a, b));

  const ordered = [
    ...orderedGroups.flatMap((group) => group.records),
    ...ungrouped,
  ];
  invoices.splice(0, invoices.length, ...ordered);
}

function cleanFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '') || 'FARA_VALOARE';
}

function cleanTaxIdPart(value: string): string {
  return cleanFilePart(value.replace(/^RO/i, ''));
}

export function sagaInvoicesFileName(
  tenantCui?: string | null,
  fallbackDate = new Date().toISOString().slice(0, 10),
): string {
  const companyTaxId = cleanTaxIdPart(tenantCui || 'FARA_CUI');
  return `F_${companyTaxId}_${fallbackDate}.xml`;
}

function buildCompatibilityCsv(invoices: SagaInvoiceRecord[]): string {
  const quote = (value: unknown) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    [
      'Tip',
      'Numar',
      'Data',
      'Furnizor',
      'CUI furnizor',
      'Client',
      'CUI client',
      'Moneda',
      'Baza',
      'TVA',
      'Total',
    ].map(quote),
    ...invoices.map(({ data, type }) =>
      [
        type,
        data.documentNumber,
        data.documentDate,
        data.vendor,
        data.vendorEin,
        data.buyer,
        data.buyerEin,
        data.currency,
        data.netAmount,
        data.vatAmount,
        data.totalAmount,
      ].map(quote),
    ),
  ];
  return rows.map((row) => row.join(';')).join('\n');
}
