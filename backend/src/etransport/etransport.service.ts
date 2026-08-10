import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import PDFDocument = require('pdfkit');
import { PrismaService } from '../common/prisma.service';
import { S3Service } from '../common/s3.service';
import { AuditService } from '../common/audit.service';
import {
  normalizeAccountingDocument,
} from '../accounting/accounting-normalizer';
import { AnafClient } from './anaf-client';
import { resolveBnrRate } from './bnr-rate';
import { ExtractionService } from '../extraction/extraction.service';
import { isVehiclePurchaseDocument } from '../vehicles/vehicle-document-sync';
import { DriveVehicleDataService } from './drive-vehicle-data.service';
import {
  buildETransportXml,
  buildETransportInfirmationXml,
  DeclarationData,
  ETransportDocument,
  ETransportGood,
  OPERATION_CODES,
} from './xml-builder';
import { eTransportCodJudet } from './judet-codes';

export interface CreateDeclarationInput {
  vehicleId?: number;
  operationType: string;
  transporter: { name: string; taxId: string; country: string };
  vehiclePlate: string;
  trailerPlate?: string;
  loadingPlace: {
    country: string;
    county?: string;
    city?: string;
    address?: string;
    borderCrossingPoint?: string;
  };
  unloadingPlace: {
    country: string;
    county?: string;
    city?: string;
    address?: string;
    borderCrossingPoint?: string;
  };
  goods: ETransportGood[];
  transportDate: string;
  /** Explicit user confirmation; extracted suggestions are never submission-ready by themselves. */
  dataVerified?: boolean;
}

// Schematron BR-004: these operation codes (intra-community acquisition/supply,
// lohn in/out, stock-at-client in/out) require a border crossing point (codPtf).
const BORDER_CROSSING_REQUIRED_CODES = new Set([
  '10', '12', '14', '20', '22', '24', '60', '70',
]);

const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR',
  'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI',
  'SK',
]);

// AIC plus the transit/non-transfer operations covered by the 15-day rule.
const FIFTEEN_DAY_OPERATION_TYPES = new Set(['AIC', 'LHI', 'LHE', 'SCI', 'SCE', 'DIN', 'DIE']);

export function validityDaysForOperation(operationType: string): number {
  return FIFTEEN_DAY_OPERATION_TYPES.has(operationType.toUpperCase()) ? 15 : 5;
}

function numberValue(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function isoDate(value: unknown): string | undefined {
  const text = textValue(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{2})[-./](\d{2})[-./](\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
}

function declarationDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateInRomania(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function selectUitPurchaseSource(
  documents: Array<{
    id: number;
    type?: string | null;
    processedData?: { extractedFields?: unknown } | null;
  }>,
  tenantCui?: string | null,
) {
  const sources = documents
    .filter((document) => document.processedData)
    .map((document) => ({
      document,
      canonical: normalizeAccountingDocument(
        document.type,
        document.processedData?.extractedFields,
        tenantCui,
      ),
    }))
    .filter(({ canonical }) => isVehiclePurchaseDocument(canonical));
  return (
    sources.find(({ document }) => document.type === 'Invoice') ??
    sources.find(({ document }) => document.type === 'Contract')
  );
}

@Injectable()
export class EtransportService {
  private readonly logger = new Logger(EtransportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anaf: AnafClient,
    private readonly audit: AuditService,
    private readonly s3: S3Service,
    private readonly extraction: ExtractionService,
    private readonly driveVehicleData: DriveVehicleDataService,
  ) {}

  driveStatus(refresh = false) {
    return this.driveVehicleData.status(refresh);
  }

  /** Official BNR rate for the UIT modal's currency conversion (date-aware). */
  async bnrRate(currencyInput: unknown, dateInput?: unknown) {
    const currency = textValue(currencyInput)?.toUpperCase();
    if (!currency) throw new BadRequestException('Selectează moneda pentru cursul BNR');
    const date = isoDate(dateInput);
    try {
      const rate = await resolveBnrRate(currency, date);
      return { currency: rate.currency, rate: rate.rate, rateDate: rate.rateDate };
    } catch (error) {
      throw new BadRequestException(
        `Cursul ${currency}/RON nu a putut fi obținut acum (${(error as Error).message}). Introdu manual cursul BNR.`,
      );
    }
  }

  async parseTransportMessage(message: unknown) {
    const source = textValue(message);
    if (!source) throw new BadRequestException('Lipește mesajul primit de la transportator');
    try {
      const fields = await this.extraction.parseTransportMessage(source);
      const foundFields = Object.entries(fields)
        .filter(([, value]) => textValue(value) != null)
        .map(([field]) => field);
      if (foundFields.length === 0) {
        throw new BadRequestException(
          'Nu am identificat date logistice în mesaj. Verifică textul sau completează câmpurile manual.',
        );
      }
      return { fields, foundFields };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.warn(`transport message extraction failed: ${(error as Error).message}`);
      throw new BadRequestException(
        'Mesajul nu a putut fi analizat acum. Completează câmpurile manual sau încearcă din nou.',
      );
    }
  }

  list(tenantId: number, vehicleId?: number) {
    return this.prisma.eTransportDeclaration.findMany({
      where: { tenantId, ...(vehicleId ? { vehicleId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { id: true, vin: true, make: true, model: true } } },
    });
  }

  async get(tenantId: number, id: number) {
    const decl = await this.prisma.eTransportDeclaration.findFirst({
      where: { id, tenantId },
      include: { vehicle: true },
    });
    if (!decl) throw new NotFoundException('Declarația nu a fost găsită');
    return decl;
  }

  /** Pre-fill invoice/contract data already attached to the selected vehicle. */
  async prefill(tenantId: number, vehicleId: number) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, tenantId },
      include: {
        tenant: {
          select: { cui: true, address: true, city: true, county: true },
        },
        seller: true,
        documents: {
          where: {
            deletedAt: null,
            type: { in: ['Invoice', 'Contract'] },
          },
          include: { processedData: true },
          orderBy: { uploadedAt: 'desc' },
        },
      },
    });
    if (!vehicle) throw new NotFoundException('Vehiculul nu a fost găsit');

    // A supplier invoice is the operational source used by the company. A
    // private purchase contract remains the fallback for acquisitions from an
    // individual, where no invoice exists.
    const purchaseSource = selectUitPurchaseSource(
      vehicle.documents,
      vehicle.tenant.cui,
    );
    const canonicalSource = purchaseSource?.canonical;
    const sourceFields = canonicalSource?.raw;

    const originCountry = (
      textValue(canonicalSource?.vendorCountry ?? vehicle.seller?.country ?? vehicle.originCountry) ?? ''
    ).toUpperCase();
    const operationType = originCountry === 'RO' ? 'TTN' : EU_COUNTRY_CODES.has(originCountry) ? 'AIC' : 'IMP';
    const tariffCode = textValue(
      sourceFields?.tariff_code ??
        canonicalSource?.lineItems.find((line) => textValue(line.raw.tariff_code))?.raw.tariff_code,
    );
    // Weight and unloading place come from the company's live VIN table, not
    // late-arriving CMR/registration documents.
    const warnings: string[] = [];
    let driveRow:
      | {
          weightKg?: number;
          unloadingCity?: string;
          rowNumber: number;
        }
      | undefined;
    let driveSource:
      | {
          fileName: string;
          sheetName: string;
          modifiedTime?: string;
          loadedAt: string;
        }
      | undefined;
    let driveDuplicateVin = false;
    try {
      const lookup = await this.driveVehicleData.lookup(vehicle.vin);
      if (!lookup.configured) {
        warnings.push(
          'Tabelul logistic Google Drive nu este conectat; completează manual MASA și LOCATIE.',
        );
      } else if (!lookup.match) {
        driveSource = lookup.source;
        warnings.push(
          `VIN ${vehicle.vin} nu a fost găsit în tabelul logistic Google Drive.`,
        );
      } else {
        driveRow = lookup.match;
        driveSource = lookup.source;
        driveDuplicateVin = Boolean(lookup.duplicateVin);
        if (driveDuplicateVin) {
          warnings.push(
            `VIN ${vehicle.vin} apare de mai multe ori în tabel; s-a folosit primul rând și trebuie verificat.`,
          );
        }
        if (!driveRow.weightKg) {
          warnings.push(`Coloana MASA este goală sau invalidă pentru VIN ${vehicle.vin}.`);
        }
        if (!driveRow.unloadingCity) {
          warnings.push(`Coloana LOCATIE este goală pentru VIN ${vehicle.vin}.`);
        }
      }
    } catch (error) {
      this.logger.warn(`Drive VIN lookup failed for ${vehicle.vin}: ${(error as Error).message}`);
      warnings.push(
        'Tabelul logistic Google Drive nu a putut fi citit; completează manual MASA și LOCATIE.',
      );
    }
    const weightKg = driveRow?.weightKg;
    const valueWithoutVat =
      numberValue(
        canonicalSource?.documentType === 'Invoice'
          ? canonicalSource.netAmount
          : canonicalSource?.totalAmount,
      ) ?? Number(vehicle.purchasePrice);
    const currency = (
      textValue(canonicalSource?.currency ?? vehicle.purchaseCurrency) ?? 'RON'
    ).toUpperCase();
    // ANAF article name for a vehicle is "<VIN> <MODEL>" (e.g.
    // "WAUZ23423JLKAISD3K TIGUAN") so the car is identifiable by chassis number.
    const goodsDescription = [vehicle.vin, vehicle.model]
      .map((part) => textValue(part))
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    const transportDate = undefined;
    const goods = await this.enrichGoodsValues(
      [{ description: goodsDescription, tariffCode, weightKg, valueWithoutVat, currency }],
      false,
      {
        exchangeRate: numberValue(canonicalSource?.exchangeRate),
        currency: textValue(canonicalSource?.currency)?.toUpperCase(),
        date: textValue(canonicalSource?.documentDate),
      },
    );

    if (!tariffCode) warnings.push('Codul NC/tarifar nu a fost găsit în factura/contractul de achiziție.');
    warnings.push('Lipește mesajul transportatorului pentru dată, transportator, numere și locul de încărcare.');
    if (!goods[0].valueRon) {
      warnings.push(
        'Cursul nu a fost găsit în documentul de achiziție și BNR nu a răspuns; introdu manual cursul BNR (sau valoarea în RON) în formular.',
      );
    }

    return {
      vehicleId,
      operationType,
      transporter: {
        name: '',
        taxId: '',
        country: originCountry,
      },
      vehiclePlate: '',
      trailerPlate: '',
      loadingPlace: {
        country: originCountry,
        city: '',
        address: '',
      },
      unloadingPlace: {
        // An intra-community acquisition is delivered to the company's own
        // premises, so default the RO county/city/street from the registered
        // company address (Settings). ANAF requires all three on the locatie.
        country: 'RO',
        county: textValue(vehicle.tenant.county) ?? '',
        city: driveRow?.unloadingCity ?? textValue(vehicle.tenant.city) ?? '',
        address: textValue(vehicle.tenant.address) ?? '',
      },
      transportDate,
      goods,
      warnings,
      fieldSources: {
        operationType: originCountry ? `țara partenerului/originii (${originCountry})` : null,
        tariffCode: tariffCode ? `${purchaseSource?.document.type === 'Invoice' ? 'factură' : 'contract'} achiziție` : null,
        weightKg: driveRow?.weightKg ? 'Google Drive · MASA' : null,
        unloadingPlace: driveRow?.unloadingCity ? 'Google Drive · LOCATIE' : null,
        value: purchaseSource?.document.type === 'Invoice' ? 'factură achiziție' : purchaseSource ? 'contract privat de achiziție' : 'preț achiziție vehicul',
        exchangeRate: goods[0].exchangeRateDate ? `BNR ${goods[0].exchangeRateDate}` : null,
      },
      drive: {
        configured: this.driveVehicleData.configured,
        matched: Boolean(driveRow),
        rowNumber: driveRow?.rowNumber ?? null,
        duplicateVin: driveDuplicateVin,
        source: driveSource ?? null,
      },
      sourceDocumentId: purchaseSource?.document.id,
    };
  }

  async create(tenantId: number, input: CreateDeclarationInput) {
    const normalized = await this.normalizeInput(input, false);
    const xml = await this.buildXml(tenantId, normalized);
    const invoiceDocumentId = await this.findPurchaseSourceDocument(tenantId, normalized.vehicleId);

    return this.prisma.eTransportDeclaration.create({
      data: {
        tenantId,
        vehicleId: normalized.vehicleId,
        operationType: normalized.operationType,
        status: 'DRAFT',
        xmlPayload: xml,
        invoiceDocumentId,
        transporter: normalized.transporter as any,
        vehiclePlate: normalized.vehiclePlate,
        trailerPlate: normalized.trailerPlate,
        loadingPlace: normalized.loadingPlace as any,
        unloadingPlace: normalized.unloadingPlace as any,
        goods: normalized.goods as any,
        transportDate: normalized.transportDate ? declarationDate(normalized.transportDate) : null,
        dataVerifiedAt: normalized.dataVerified ? new Date() : null,
      },
    });
  }

  /**
   * Regeneration flow: any declaration that is not in flight can be edited.
   * The XML is rebuilt, the old UIT is invalidated (status back to DRAFT) and
   * a resubmission obtains a fresh cod UIT.
   */
  async update(tenantId: number, userId: number, id: number, input: CreateDeclarationInput) {
    const decl = await this.get(tenantId, id);
    if (decl.status === 'SUBMITTED') {
      throw new BadRequestException('Declarația este în curs de procesare la ANAF — așteaptă răspunsul înainte de modificare');
    }
    const normalized = await this.normalizeInput(input, false);
    const xml = await this.buildXml(tenantId, normalized);
    const invoiceDocumentId = await this.findPurchaseSourceDocument(
      tenantId,
      normalized.vehicleId ?? decl.vehicleId ?? undefined,
    );

    const updated = await this.prisma.eTransportDeclaration.update({
      where: { id },
      data: {
        vehicleId: normalized.vehicleId ?? decl.vehicleId,
        operationType: normalized.operationType,
        status: 'DRAFT',
        uit: null,
        uitDocumentId: null,
        anafUploadId: null,
        infirmationUploadId: null,
        infirmationReason: null,
        infirmationResponse: Prisma.DbNull,
        infirmedAt: null,
        declaredAt: null,
        validFrom: null,
        validUntil: null,
        xmlPayload: xml,
        invoiceDocumentId,
        transporter: normalized.transporter as any,
        vehiclePlate: normalized.vehiclePlate,
        trailerPlate: normalized.trailerPlate,
        loadingPlace: normalized.loadingPlace as any,
        unloadingPlace: normalized.unloadingPlace as any,
        goods: normalized.goods as any,
        transportDate: normalized.transportDate ? declarationDate(normalized.transportDate) : null,
        dataVerifiedAt: normalized.dataVerified ? new Date() : null,
      },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'etransport.updated',
      entity: 'ETransportDeclaration',
      entityId: id,
      details: { previousStatus: decl.status, previousUit: decl.uit },
    });
    return updated;
  }

  private async buildXml(tenantId: number, input: CreateDeclarationInput): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const data: DeclarationData = {
      tenantCui: tenant?.cui ?? '',
      operationType: input.operationType,
      transporter: input.transporter,
      partner: await this.resolvePartner(tenantId, input),
      vehiclePlate: input.vehiclePlate,
      trailerPlate: input.trailerPlate,
      loadingPlace: input.loadingPlace,
      unloadingPlace: input.unloadingPlace,
      goods: input.goods,
      transportDate: input.transportDate,
      documents: await this.resolveTransportDocuments(tenantId, input),
    };
    return buildETransportXml(data);
  }

  /**
   * The XSD requires at least one documenteTransport. Reference the vehicle's
   * purchase document (supplier invoice → Factură/20, otherwise Altele/9999),
   * falling back to a CMR (10) dated on the transport day when no source exists.
   */
  private async resolveTransportDocuments(
    tenantId: number,
    input: CreateDeclarationInput,
  ): Promise<ETransportDocument[]> {
    const fallback: ETransportDocument[] = [
      { tipDocument: '10', dataDocument: input.transportDate },
    ];
    if (!input.vehicleId) return fallback;
    const [tenant, docs] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { cui: true },
      }),
      this.prisma.document.findMany({
        where: {
          tenantId,
          vehicleId: input.vehicleId,
          type: { in: ['Invoice', 'Contract'] },
          deletedAt: null,
          processedData: { isNot: null },
        },
        include: { processedData: true },
        orderBy: { uploadedAt: 'desc' },
      }),
    ]);
    const source = selectUitPurchaseSource(docs, tenant?.cui);
    if (!source) return fallback;
    return [
      {
        tipDocument: source.document.type === 'Invoice' ? '20' : '9999',
        dataDocument:
          isoDate(source.canonical.documentDate) ?? input.transportDate,
        documentNumber: textValue(source.canonical.documentNumber),
      },
    ];
  }

  /**
   * The commercial partner (partenerComercial) is the seller in the acquisition,
   * taken from the vehicle's purchase document (the intra-community supplier,
   * e.g. AUTO1) — not the transporter. Returns undefined when unresolved, so the
   * builder falls back to the transporter.
   */
  private async resolvePartner(
    tenantId: number,
    input: CreateDeclarationInput,
  ): Promise<{ name: string; taxId?: string; country: string } | undefined> {
    if (!input.vehicleId) return undefined;
    const [tenant, docs] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { cui: true },
      }),
      this.prisma.document.findMany({
        where: {
          tenantId,
          vehicleId: input.vehicleId,
          type: { in: ['Invoice', 'Contract'] },
          deletedAt: null,
          processedData: { isNot: null },
        },
        include: { processedData: true },
        orderBy: { uploadedAt: 'desc' },
      }),
    ]);
    const source = selectUitPurchaseSource(docs, tenant?.cui);
    const name = textValue(source?.canonical.vendor);
    const country = textValue(source?.canonical.vendorCountry)?.toUpperCase();
    if (!name || !country) return undefined;
    return { name, country, taxId: textValue(source?.canonical.vendorEin) };
  }

  private async normalizeInput(input: CreateDeclarationInput, strictExchangeRate: boolean): Promise<CreateDeclarationInput> {
    const operationType = textValue(input.operationType)?.toUpperCase() ?? '';
    const transportDate = isoDate(input.transportDate) ?? '';
    return {
      ...input,
      operationType,
      transportDate,
      vehiclePlate: textValue(input.vehiclePlate)?.toUpperCase() ?? '',
      trailerPlate: textValue(input.trailerPlate)?.toUpperCase(),
      transporter: {
        name: textValue(input.transporter?.name) ?? '',
        taxId: textValue(input.transporter?.taxId) ?? '',
        country: textValue(input.transporter?.country)?.toUpperCase() ?? '',
      },
      loadingPlace: {
        ...input.loadingPlace,
        country: textValue(input.loadingPlace?.country)?.toUpperCase() ?? '',
      },
      unloadingPlace: {
        ...input.unloadingPlace,
        country: textValue(input.unloadingPlace?.country)?.toUpperCase() ?? '',
      },
      goods: await this.enrichGoodsValues(input.goods ?? [], strictExchangeRate),
    };
  }

  /**
   * Resolve each good's RON value through a fallback chain so the declaration
   * never dead-ends on the BNR feed (which is WAF-blocked from datacenters like
   * Render): a rate already on the good (entered manually or carried from an
   * earlier save/prefill) wins, then the rate printed on the acquisition
   * document, and only last a best-effort live BNR call. When strict (on send)
   * and nothing yields a rate, we ask for a manual curs instead of silently
   * blocking.
   */
  private async enrichGoodsValues(
    goods: ETransportGood[],
    strict: boolean,
    source?: { exchangeRate?: number; currency?: string; date?: string },
  ): Promise<ETransportGood[]> {
    const round2 = (value: number) => Math.round(value * 100) / 100;
    const round4 = (value: number) => Math.round(value * 10000) / 10000;
    return Promise.all(
      goods.map(async (good) => {
        const currency = textValue(good.currency)?.toUpperCase();
        const valueWithoutVat = numberValue(good.valueWithoutVat);
        const manualValueRon = numberValue(good.valueRon);
        const manualRate = numberValue(good.exchangeRate);
        const normalized: ETransportGood = {
          ...good,
          description: textValue(good.description) ?? '',
          tariffCode: textValue(good.tariffCode)?.replace(/\s+/g, ''),
          weightKg: numberValue(good.weightKg),
          valueWithoutVat,
          currency,
          valueRon: manualValueRon,
          exchangeRate: manualRate,
          exchangeRateDate: textValue(good.exchangeRateDate) ?? undefined,
        };

        if (valueWithoutVat == null || !currency) return normalized;

        // RON needs no conversion.
        if (currency === 'RON') {
          return {
            ...normalized,
            valueRon: manualValueRon ?? valueWithoutVat,
            exchangeRate: undefined,
            exchangeRateDate: undefined,
          };
        }

        // 1. A rate already on the good wins (manual entry or carried forward).
        if (manualRate && manualRate > 0) {
          return {
            ...normalized,
            valueRon:
              manualValueRon && manualValueRon > 0
                ? manualValueRon
                : round2(valueWithoutVat * manualRate),
            exchangeRate: manualRate,
            exchangeRateDate: normalized.exchangeRateDate ?? source?.date ?? dateInRomania(),
          };
        }
        // 2. Only a RON value was supplied — back out the implied rate.
        if (manualValueRon && manualValueRon > 0) {
          return {
            ...normalized,
            valueRon: manualValueRon,
            exchangeRate: round4(manualValueRon / valueWithoutVat),
            exchangeRateDate: normalized.exchangeRateDate ?? source?.date ?? dateInRomania(),
          };
        }
        // 3. Rate printed on the acquisition document (curs_valutar): the
        //    official rate for this purchase, always reachable.
        if (
          source?.exchangeRate &&
          source.exchangeRate > 0 &&
          (!source.currency || source.currency === currency)
        ) {
          return {
            ...normalized,
            valueRon: round2(valueWithoutVat * source.exchangeRate),
            exchangeRate: source.exchangeRate,
            exchangeRateDate: source.date ?? dateInRomania(),
          };
        }
        // 4. Live BNR feed (cursbnr.ro, date-aware) — best-effort; degrades
        //    instead of hard-blocking.
        try {
          const bnr = await resolveBnrRate(currency, source?.date);
          return {
            ...normalized,
            valueRon: round2(valueWithoutVat * bnr.rate),
            exchangeRate: bnr.rate,
            exchangeRateDate: bnr.rateDate,
          };
        } catch (error) {
          if (strict) {
            throw new BadRequestException(
              `Nu s-a putut obține automat cursul ${currency}/RON (nici din documentul de achiziție, nici de la BNR: ${(error as Error).message}). Introdu manual cursul BNR în formular și retrimite.`,
            );
          }
          return { ...normalized, valueRon: undefined, exchangeRate: undefined, exchangeRateDate: undefined };
        }
      }),
    );
  }

  /** Latest purchase invoice, with private contract fallback. */
  private async findPurchaseSourceDocument(
    tenantId: number,
    vehicleId?: number,
  ): Promise<number | null> {
    if (!vehicleId) return null;
    const [tenant, contracts] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { cui: true },
      }),
      this.prisma.document.findMany({
        where: {
          tenantId,
          vehicleId,
          type: { in: ['Invoice', 'Contract'] },
          deletedAt: null,
          processedData: { isNot: null },
        },
        include: { processedData: true },
        orderBy: { uploadedAt: 'desc' },
      }),
    ]);
    return selectUitPurchaseSource(contracts, tenant?.cui)?.document.id ?? null;
  }

  async submit(tenantId: number, userId: number, id: number) {
    const decl = await this.get(tenantId, id);
    if (decl.status !== 'DRAFT' && decl.status !== 'REJECTED') {
      throw new BadRequestException(`Declarația este deja în starea ${decl.status}`);
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.cui) {
      throw new BadRequestException('Completează CUI-ul firmei înainte de a declara în e-Transport');
    }

    if (!decl.dataVerifiedAt) {
      throw new BadRequestException(
        'Verifică tipul operațiunii, codul tarifar, greutatea, valoarea și cursul valutar, apoi confirmă datele înainte de trimitere.',
      );
    }

    const input = await this.normalizeInput(
      {
        vehicleId: decl.vehicleId ?? undefined,
        operationType: decl.operationType,
        transporter: decl.transporter as any,
        vehiclePlate: decl.vehiclePlate ?? '',
        trailerPlate: decl.trailerPlate ?? undefined,
        loadingPlace: decl.loadingPlace as any,
        unloadingPlace: decl.unloadingPlace as any,
        goods: decl.goods as unknown as ETransportGood[],
        transportDate: decl.transportDate?.toISOString().slice(0, 10) ?? '',
        dataVerified: true,
      },
      true,
    );
    this.validateForSubmission(input);
    const xml = await this.buildXml(tenantId, input);

    // The legal conversion date is the declaration date, so refresh both the
    // persisted goods and XML immediately before the ANAF request.
    await this.prisma.eTransportDeclaration.update({
      where: { id },
      data: { goods: input.goods as any, xmlPayload: xml },
    });

    const uploadId = await this.anaf.submitDeclaration(tenantId, tenant.cui, xml);

    const updated = await this.prisma.eTransportDeclaration.update({
      where: { id },
      data: { status: 'SUBMITTED', anafUploadId: uploadId, declaredAt: new Date() },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: 'etransport.submitted',
      entity: 'ETransportDeclaration',
      entityId: id,
      details: { uploadId },
    });
    return updated;
  }

  /** Remove a local draft only; this endpoint never sends a cancellation to ANAF. */
  async removeDraft(tenantId: number, userId: number, id: number) {
    const decl = await this.get(tenantId, id);
    if (decl.status !== 'DRAFT') {
      throw new BadRequestException(
        'Poți șterge doar ciornele care nu au fost înregistrate la ANAF',
      );
    }
    await this.prisma.eTransportDeclaration.delete({ where: { id } });
    await this.audit.log({
      tenantId,
      userId,
      action: 'etransport.draft_deleted',
      entity: 'ETransportDeclaration',
      entityId: id,
      details: { operationType: decl.operationType, vehicleId: decl.vehicleId },
    });
    return { id, deleted: true };
  }

  /** Submit the official tipConfirmare=30 message for an existing valid UIT. */
  async infirm(
    tenantId: number,
    userId: number,
    id: number,
    reasonInput: unknown,
  ) {
    const reason = textValue(reasonInput);
    if (!reason || reason.length < 3) {
      throw new BadRequestException('Completează motivul infirmării (minimum 3 caractere)');
    }
    if (reason.length > 200) {
      throw new BadRequestException('Motivul infirmării poate avea maximum 200 de caractere');
    }

    const decl = await this.get(tenantId, id);
    if (decl.status !== 'CONFIRMED' || !decl.uit) {
      throw new BadRequestException('Poți infirma doar o declarație confirmată, care are cod UIT');
    }
    if (decl.validUntil && decl.validUntil.getTime() < Date.now()) {
      throw new BadRequestException('Codul UIT a expirat și nu mai poate fi infirmat din AutoImport');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { cui: true },
    });
    if (!tenant?.cui) {
      throw new BadRequestException('Completează CUI-ul firmei înainte de infirmarea la ANAF');
    }

    const xml = buildETransportInfirmationXml(tenant.cui, decl.uit, reason);
    const uploadId = await this.anaf.submitDeclaration(tenantId, tenant.cui, xml);
    const updated = await this.prisma.eTransportDeclaration.update({
      where: { id },
      data: {
        status: 'INFIRMING',
        infirmationUploadId: uploadId,
        infirmationReason: reason,
        infirmationResponse: { submittedXml: xml },
        infirmedAt: null,
      },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'etransport.infirmation_submitted',
      entity: 'ETransportDeclaration',
      entityId: id,
      details: { uit: decl.uit, uploadId, reason },
    });
    return updated;
  }

  private validateForSubmission(input: CreateDeclarationInput): void {
    const errors: string[] = [];
    if (!OPERATION_CODES[input.operationType]) errors.push('tipul operațiunii');
    if (!input.transportDate) {
      errors.push('data transportului');
    } else {
      const today = dateInRomania();
      const maximum = declarationDate(today);
      maximum.setUTCDate(maximum.getUTCDate() + 3);
      const maximumDate = maximum.toISOString().slice(0, 10);
      if (input.transportDate < today || input.transportDate > maximumDate) {
        throw new BadRequestException(
          `Data transportului trebuie să fie între ${today} și ${maximumDate} (maximum 3 zile înainte).`,
        );
      }
    }
    if (!input.transporter.name) errors.push('denumirea transportatorului');
    if (!/^[A-Z]{2}$/.test(input.transporter.country)) errors.push('țara transportatorului');
    // Schematron BR-043: a Romanian transport organizer on a non-national
    // operation must carry its CUI (codOrgTransport).
    if (
      input.transporter.country?.toUpperCase() === 'RO' &&
      OPERATION_CODES[input.operationType] !== '30' &&
      !textValue(input.transporter.taxId)
    ) {
      errors.push('codul fiscal (CUI) al transportatorului');
    }
    if (!input.vehiclePlate) errors.push('numărul vehiculului de transport');
    if (!/^[A-Z]{2}$/.test(input.loadingPlace.country)) errors.push('țara de încărcare');
    if (!/^[A-Z]{2}$/.test(input.unloadingPlace.country)) errors.push('țara de descărcare');
    // A Romanian leg is emitted as a <locatie>, whose codJudet and
    // denumireLocalitate are required. denumireStrada is also required by the XSD
    // but the builder falls back to the city when no street is given, so we only
    // need a valid county + city here. Catch those with a clear message.
    const validateRomanianPlace = (
      place: { country?: string; county?: string; city?: string; address?: string },
      label: string,
    ) => {
      if ((place.country ?? '').toUpperCase() !== 'RO') return;
      if (!eTransportCodJudet(place.county)) errors.push(`județul ${label} (cod valid)`);
      if (!textValue(place.city)) errors.push(`localitatea ${label}`);
    };
    validateRomanianPlace(input.loadingPlace, 'locului de încărcare');
    validateRomanianPlace(input.unloadingPlace, 'locului de descărcare');
    // Schematron BR-004: intra-community / lohn / stock operations cross the EU
    // border, so a border crossing point (codPtf) is mandatory.
    if (BORDER_CROSSING_REQUIRED_CODES.has(OPERATION_CODES[input.operationType])) {
      const border =
        input.loadingPlace.borderCrossingPoint ??
        input.unloadingPlace.borderCrossingPoint;
      if (!textValue(border)) errors.push('punctul de trecere a frontierei (vamă)');
    }
    if (!input.goods.length) errors.push('cel puțin o poziție de bunuri');

    input.goods.forEach((good, index) => {
      const position = `bunuri poziția ${index + 1}`;
      if (!textValue(good.description)) errors.push(`${position}: denumire`);
      if (!/^\d{4,10}$/.test(good.tariffCode ?? '')) errors.push(`${position}: cod NC/tarifar verificat`);
      if (!(numberValue(good.weightKg)! > 0)) errors.push(`${position}: greutate brută reală`);
      if (!(numberValue(good.valueRon)! > 0)) errors.push(`${position}: valoare fără TVA în RON`);
      if (good.currency && good.currency !== 'RON') {
        if (!(numberValue(good.valueWithoutVat)! > 0)) errors.push(`${position}: valoare în moneda facturii`);
        if (!(numberValue(good.exchangeRate)! > 0) || !good.exchangeRateDate) {
          errors.push(`${position}: curs oficial BNR`);
        }
      }
    });

    if (errors.length) {
      throw new BadRequestException(`Declarația nu poate fi trimisă. Verifică: ${errors.join('; ')}.`);
    }
  }

  /** Poll ANAF for both initial submissions and infirmation messages. */
  @Cron('0 */2 * * * *')
  async pollStatuses() {
    if (!this.anaf.configured) return;
    const pending = await this.prisma.eTransportDeclaration.findMany({
      where: {
        OR: [
          { status: 'SUBMITTED', anafUploadId: { not: null } },
          { status: 'INFIRMING', infirmationUploadId: { not: null } },
        ],
      },
      take: 20,
    });
    for (const decl of pending) {
      try {
        const infirming = decl.status === 'INFIRMING';
        const uploadId = infirming ? decl.infirmationUploadId! : decl.anafUploadId!;
        const result = await this.anaf.checkStatus(decl.tenantId, uploadId);
        if (infirming) {
          if (result.status === 'CONFIRMED') {
            await this.prisma.eTransportDeclaration.update({
              where: { id: decl.id },
              data: {
                status: 'INFIRMED',
                infirmedAt: new Date(),
                infirmationResponse: { raw: result.raw },
              },
            });
            await this.audit.log({
              tenantId: decl.tenantId,
              action: 'etransport.infirmed',
              entity: 'ETransportDeclaration',
              entityId: decl.id,
              details: { uit: decl.uit, uploadId },
            });
          } else if (result.status === 'REJECTED') {
            // The infirmation failed; the original confirmed UIT remains valid.
            await this.prisma.eTransportDeclaration.update({
              where: { id: decl.id },
              data: {
                status: 'CONFIRMED',
                infirmationResponse: { raw: result.raw },
              },
            });
            await this.audit.log({
              tenantId: decl.tenantId,
              action: 'etransport.infirmation_rejected',
              entity: 'ETransportDeclaration',
              entityId: decl.id,
              details: { uit: decl.uit, uploadId },
            });
          }
          continue;
        }
        if (result.status === 'CONFIRMED') {
          const validFrom = decl.transportDate ?? decl.declaredAt ?? new Date();
          const validUntil = new Date(validFrom);
          validUntil.setUTCDate(validUntil.getUTCDate() + validityDaysForOperation(decl.operationType));
          const confirmed = await this.prisma.eTransportDeclaration.update({
            where: { id: decl.id },
            data: {
              status: 'CONFIRMED',
              uit: result.uit,
              anafResponse: { raw: result.raw } as any,
              validFrom,
              validUntil,
            },
          });
          await this.saveUitSheet(confirmed.id).catch((err) =>
            this.logger.warn(`saving UIT sheet for declaration ${decl.id} failed: ${(err as Error).message}`),
          );
        } else if (result.status === 'REJECTED') {
          await this.prisma.eTransportDeclaration.update({
            where: { id: decl.id },
            data: { status: 'REJECTED', anafResponse: { raw: result.raw } as any },
          });
        }
      } catch (err) {
        this.logger.warn(`poll failed for declaration ${decl.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Once confirmed, the printable
   * UIT sheet is stored in the document store, attached to the vehicle and
   * linked to the private purchase contract via a DocumentRelationship.
   */
  private async saveUitSheet(declarationId: number) {
    const decl = await this.prisma.eTransportDeclaration.findUnique({ where: { id: declarationId } });
    if (!decl?.uit || decl.uitDocumentId) return;

    const pdf = await this.renderUitPdf(decl.tenantId, decl);
    const fileName = `UIT_${decl.uit}.pdf`;
    const s3Key = `tenants/${decl.tenantId}/etransport/${randomUUID()}/${fileName}`;
    await this.s3.putObject(s3Key, pdf, 'application/pdf');

    const uitDoc = await this.prisma.document.create({
      data: {
        name: fileName,
        type: 'UIT',
        s3Key,
        contentType: 'application/pdf',
        fileSize: pdf.length,
        documentHash: createHash('sha256').update(pdf).digest('hex'),
        tenantId: decl.tenantId,
        vehicleId: decl.vehicleId,
        processingStatus: 'COMPLETED',
      },
    });

    await this.prisma.eTransportDeclaration.update({
      where: { id: declarationId },
      data: { uitDocumentId: uitDoc.id },
    });
    if (decl.invoiceDocumentId) {
      await this.prisma.documentRelationship.create({
        data: { parentId: decl.invoiceDocumentId, childId: uitDoc.id, relation: 'uit' },
      });
    }
  }

  /** Printable UIT sheet the driver carries with the transport. */
  async uitSheet(tenantId: number, id: number): Promise<Buffer> {
    const decl = await this.get(tenantId, id);
    if (!decl.uit) throw new BadRequestException('Declarația nu are încă un cod UIT');
    return this.renderUitPdf(tenantId, decl);
  }

  private async renderUitPdf(tenantId: number, decl: any): Promise<Buffer> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(16).text('DOCUMENT ÎNSOȚITOR TRANSPORT — RO e-Transport', { align: 'center' });
      doc.moveDown(1.5);
      doc.fontSize(28).text(`Cod UIT: ${decl.uit}`, { align: 'center' });
      doc.moveDown(1.5);
      doc.font('Helvetica').fontSize(11);
      const t = decl.transporter as any;
      const lines = [
        `Declarant: ${tenant?.name ?? ''} (CUI ${tenant?.cui ?? ''})`,
        `Transportator: ${t?.name ?? ''} (${t?.taxId ?? ''}, ${t?.country ?? ''})`,
        `Nr. înmatriculare vehicul: ${decl.vehiclePlate ?? ''}${decl.trailerPlate ? ` / remorcă ${decl.trailerPlate}` : ''}`,
        `Tip operațiune: ${decl.operationType}`,
        `Valabil: ${decl.validFrom?.toLocaleDateString('ro-RO') ?? '—'} – ${decl.validUntil?.toLocaleDateString('ro-RO') ?? '—'}`,
        `Declarat la: ${decl.declaredAt?.toLocaleString('ro-RO') ?? '—'}`,
      ];
      for (const line of lines) {
        doc.text(line);
        doc.moveDown(0.4);
      }
      doc.moveDown(1);
      doc.fontSize(9).fillColor('#555555').text(
        'Acest document trebuie să însoțească transportul. Codul UIT se prezintă organelor de control la cerere.',
      );
      doc.end();
    });
  }
}
