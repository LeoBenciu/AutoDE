import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CanonicalAccountingDocument,
  isVehiclePurchaseContract,
  normalizeAccountingDocument,
  normalizeDate,
  normalizeEin,
  unwrapExtractedFields,
} from '../accounting/accounting-normalizer';
import { PrismaService } from '../common/prisma.service';
import { privateSellerIdentityErrors } from '../parties/party-identity';
import { ensureVehicleArticle } from '../accounting/vehicle-article';
import {
  deleteVehicleAndDetachReferences,
  isVehiclePurchaseDocument,
} from '../vehicles/vehicle-document-sync';

interface DraftVehicleCandidate {
  vin: string;
  make: string;
  model: string;
  variant?: string;
  firstRegistered?: Date;
  year: number;
  mileageKm?: number;
  fuelType?: string;
  color?: string;
  originCountry: string;
  status: 'SOURCED' | 'PURCHASED';
  purchasePrice: number;
  purchaseCurrency: string;
}

/**
 * Applies vehicle documents to the operational catalogue. A draft may create
 * only a provisional vehicle so related costs can be linked before approval.
 * Seller, contract and accounting effects remain approval-only.
 */
@Injectable()
export class DocumentDomainSyncService {
  private readonly logger = new Logger(DocumentDomainSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Makes a VIN available to the review UI as soon as extraction finishes.
   * Existing vehicles are only linked, never marked as draft-owned or mutated.
   */
  async syncDraftVehicle(
    documentId: number,
  ): Promise<{ vehicleId?: number }> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: {
        processedData: true,
        tenant: { select: { cui: true, defaultCurrency: true } },
      },
    });
    if (
      !document?.processedData ||
      document.deletedAt ||
      document.reviewStatus === 'APPROVED'
    ) {
      return {};
    }

    const fields = unwrapExtractedFields(document.processedData.extractedFields);
    const vin = extractedVin(fields);
    const candidate = this.draftVehicleCandidate(document, fields, vin);

    const vehicleId = await this.prisma.$transaction(async (tx) => {
      const assigned = document.vehicleId
        ? await tx.vehicle.findFirst({
            where: { id: document.vehicleId, tenantId: document.tenantId },
          })
        : null;

      if (assigned?.draftSourceDocumentId === document.id) {
        if (!candidate || normalizeVin(assigned.vin) !== vin) {
          await deleteVehicleAndDetachReferences(tx, assigned.id);
        } else {
          const updated = await tx.vehicle.update({
            where: { id: assigned.id },
            data: candidate,
          });
          return updated.id;
        }
      } else if (assigned) {
        if (!vin || normalizeVin(assigned.vin) === vin) return assigned.id;
        this.logger.warn(
          `document ${document.id} VIN ${vin} does not match assigned vehicle ${assigned.vin}`,
        );
        await tx.document.update({
          where: { id: document.id },
          data: { needsReview: true },
        });
        return undefined;
      }

      if (!vin) return undefined;
      const existing = await tx.vehicle.findUnique({
        where: { tenantId_vin: { tenantId: document.tenantId, vin } },
      });
      if (existing) {
        await tx.document.update({
          where: { id: document.id },
          data: { vehicleId: existing.id },
        });
        return existing.id;
      }
      if (!candidate) return undefined;

      const vehicle = await tx.vehicle.upsert({
        where: { tenantId_vin: { tenantId: document.tenantId, vin } },
        update: {},
        create: {
          tenantId: document.tenantId,
          ...candidate,
          draftSourceDocumentId: document.id,
        },
      });
      await tx.document.update({
        where: { id: document.id },
        data: { vehicleId: vehicle.id },
      });
      return vehicle.id;
    });

    if (!vehicleId) return {};
    await this.attachRelatedDocuments(
      document.tenantId,
      vehicleId,
      vin!,
      document.id,
    );
    return { vehicleId };
  }

  async sync(documentId: number): Promise<{ vehicleId?: number; sellerId?: number }> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: {
        processedData: true,
        tenant: { select: { cui: true, country: true, defaultCurrency: true } },
      },
    });
    if (!document?.processedData || document.reviewStatus !== 'APPROVED') {
      return {};
    }

    const fields = unwrapExtractedFields(document.processedData.extractedFields);
    let result: { vehicleId?: number; sellerId?: number } = {};
    if (document.type === 'Vehicle Registration Certificate') {
      result = await this.syncRegistrationCertificate(document, fields);
    } else if (document.type === 'Contract') {
      const canonical = normalizeAccountingDocument(
        document.type,
        fields,
        document.tenant.cui,
      );
      if (isVehiclePurchaseContract(canonical)) {
        result = await this.syncVehiclePurchase(document, canonical);
      }
    } else if (['CMR', 'Invoice', 'Receipt'].includes(document.type ?? '')) {
      const vehicleId = await this.attachVinDocument(document, fields);
      result = vehicleId ? { vehicleId } : {};
    }

    if (result.vehicleId) {
      await this.prisma.vehicle.updateMany({
        where: {
          id: result.vehicleId,
          draftSourceDocumentId: document.id,
        },
        data: { draftSourceDocumentId: null },
      });
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: result.vehicleId },
        select: { vin: true },
      });
      if (vehicle) {
        await this.attachRelatedDocuments(
          document.tenantId,
          result.vehicleId,
          vehicle.vin,
          document.id,
        );
      }
    }
    return result;
  }

  private draftVehicleCandidate(
    document: any,
    fields: Record<string, any>,
    vin?: string,
  ): DraftVehicleCandidate | undefined {
    if (!vin) return undefined;
    const firstRegistered = extractedDate(
      fields.first_registration_date ?? fields.firstRegistered,
    );
    const year =
      validVehicleYear(
        fields.vehicle_year ?? fields.manufacture_year ?? fields.year,
      ) ??
      firstRegistered?.getUTCFullYear() ??
      new Date().getUTCFullYear();

    if (document.type === 'Vehicle Registration Certificate') {
      return {
        vin,
        make: cleanString(fields.make ?? fields.vehicle_make) || 'Necunoscut',
        model: cleanString(fields.model ?? fields.vehicle_model) || 'Necunoscut',
        variant: optionalString(fields.variant ?? fields.vehicle_variant),
        firstRegistered,
        year,
        mileageKm: positiveInteger(fields.mileage_km ?? fields.mileage),
        fuelType: optionalString(fields.fuel_type),
        color: optionalString(fields.color),
        originCountry: countryCode(
          fields.registration_country ?? fields.country,
          'DE',
        ),
        status: 'SOURCED',
        purchasePrice: 0,
        purchaseCurrency: document.tenant.defaultCurrency || 'EUR',
      };
    }

    if (!['Invoice', 'Contract'].includes(document.type ?? '')) return undefined;
    const canonical = normalizeAccountingDocument(
      document.type,
      fields,
      document.tenant.cui,
    );
    if (!isVehiclePurchaseDocument(canonical)) return undefined;
    return {
      vin,
      make:
        cleanString(fields.vehicle_make ?? fields.make) || 'Necunoscut',
      model:
        cleanString(fields.vehicle_model ?? fields.model) || 'Necunoscut',
      variant: optionalString(fields.vehicle_variant ?? fields.variant),
      firstRegistered,
      year,
      mileageKm: positiveInteger(fields.mileage_km ?? fields.mileage),
      fuelType: optionalString(fields.fuel_type),
      color: optionalString(fields.color),
      originCountry: countryCode(canonical.vendorCountry, 'DE'),
      status: 'PURCHASED',
      purchasePrice: Math.max(0, canonical.totalAmount),
      purchaseCurrency:
        canonical.currency || document.tenant.defaultCurrency || 'EUR',
    };
  }

  private async syncRegistrationCertificate(document: any, fields: Record<string, any>) {
    const vin = extractedVin(fields);
    if (!vin) {
      this.logger.warn(`registration document ${document.id} has no valid VIN`);
      return {};
    }
    const firstRegistered = extractedDate(fields.first_registration_date);
    const extractedYear = validVehicleYear(
      fields.vehicle_year ?? fields.manufacture_year ?? fields.year,
    );
    const year = extractedYear ?? firstRegistered?.getUTCFullYear();

    return this.prisma.$transaction(async (tx) => {
      let vehicle = await this.vehicleForDocument(tx, document, vin);
      if (!vehicle && document.vehicleId) return {};
      if (!vehicle) {
        vehicle = await tx.vehicle.create({
          data: {
            tenantId: document.tenantId,
            vin,
            make: cleanString(fields.make) || 'Necunoscut',
            model: cleanString(fields.model) || 'Necunoscut',
            variant: optionalString(fields.variant),
            firstRegistered,
            year: year ?? new Date().getUTCFullYear(),
            fuelType: optionalString(fields.fuel_type),
            color: optionalString(fields.color),
            originCountry: countryCode(
              fields.registration_country ?? fields.country,
              'DE',
            ),
            status: 'SOURCED',
            purchasePrice: 0,
            purchaseCurrency: document.tenant.defaultCurrency || 'EUR',
          },
        });
      } else {
        vehicle = await tx.vehicle.update({
          where: { id: vehicle.id },
          data: {
            make: optionalString(fields.make),
            model: optionalString(fields.model),
            variant: optionalString(fields.variant),
            firstRegistered: firstRegistered ?? undefined,
            year: year ?? undefined,
            fuelType: optionalString(fields.fuel_type),
            color: optionalString(fields.color),
          },
        });
      }
      await ensureVehicleArticle(tx, document.tenantId, vehicle);
      await tx.document.update({
        where: { id: document.id },
        data: { vehicleId: vehicle.id },
      });
      return { vehicleId: vehicle.id };
    });
  }

  private async syncVehiclePurchase(
    document: any,
    canonical: CanonicalAccountingDocument,
  ) {
    const fields = canonical.raw;
    const vin = extractedVin(fields);
    const firstRegistered = extractedDate(fields.first_registration_date);
    const year =
      validVehicleYear(fields.vehicle_year ?? fields.manufacture_year ?? fields.year) ??
      firstRegistered?.getUTCFullYear();

    return this.prisma.$transaction(async (tx) => {
      let vehicle = await this.vehicleForDocument(tx, document, vin);
      if (!vehicle && document.vehicleId) return {};
      if (!vehicle && !vin) return {};
      const sellerId = await this.findOrCreateExtractedSeller(
        tx,
        document.tenantId,
        canonical,
        document.partyId,
      );

      if (!vehicle) {
        vehicle = await tx.vehicle.create({
          data: {
            tenantId: document.tenantId,
            vin: vin!,
            make: cleanString(fields.vehicle_make ?? fields.make) || 'Necunoscut',
            model: cleanString(fields.vehicle_model ?? fields.model) || 'Necunoscut',
            variant: optionalString(fields.vehicle_variant ?? fields.variant),
            firstRegistered,
            year: year ?? new Date().getUTCFullYear(),
            mileageKm: positiveInteger(fields.mileage_km),
            originCountry: countryCode(canonical.vendorCountry, 'DE'),
            status: 'PURCHASED',
            purchasePrice: canonical.totalAmount,
            purchaseCurrency: canonical.currency,
            sellerId,
          },
        });
      } else {
        vehicle = await tx.vehicle.update({
          where: { id: vehicle.id },
          data: {
            make: optionalString(fields.vehicle_make ?? fields.make),
            model: optionalString(fields.vehicle_model ?? fields.model),
            variant: optionalString(fields.vehicle_variant ?? fields.variant),
            firstRegistered: firstRegistered ?? undefined,
            year: year ?? undefined,
            mileageKm: positiveInteger(fields.mileage_km),
            purchasePrice: canonical.totalAmount > 0 ? canonical.totalAmount : undefined,
            purchaseCurrency: canonical.currency || undefined,
            sellerId,
            status: vehicle.status === 'SOURCED' ? 'PURCHASED' : undefined,
          },
        });
      }
      await ensureVehicleArticle(tx, document.tenantId, vehicle);

      await tx.document.update({
        where: { id: document.id },
        data: { vehicleId: vehicle.id, partyId: sellerId ?? undefined },
      });
      if (document.type === 'Contract') {
        const contractData = {
          tenantId: document.tenantId,
          vehicleId: vehicle.id,
          partyId: sellerId,
          direction: 'INCOMING' as const,
          contractType: cleanString(fields.contract_type) || 'achizitie',
          contractNumber: optionalString(fields.contract_number),
          contractDate: extractedDate(fields.contract_date),
          totalValue: canonical.totalAmount || null,
          currency: canonical.currency,
          extractedFields: fields as Prisma.InputJsonValue,
        };
        const existingContract = await tx.contract.findFirst({
          where: { documentId: document.id },
          select: { id: true },
        });
        if (existingContract) {
          await tx.contract.update({
            where: { id: existingContract.id },
            data: contractData,
          });
        } else {
          await tx.contract.create({
            data: { ...contractData, documentId: document.id },
          });
        }
      }
      return { vehicleId: vehicle.id, sellerId: sellerId ?? undefined };
    });
  }

  private async attachVinDocument(document: any, fields: Record<string, any>) {
    const vin = extractedVin(fields);
    if (!vin) return document.vehicleId ?? undefined;
    return this.prisma.$transaction(async (tx) => {
      const vehicle = await this.vehicleForDocument(tx, document, vin);
      if (!vehicle) return undefined;
      await tx.document.update({
        where: { id: document.id },
        data: { vehicleId: vehicle.id },
      });
      return vehicle.id;
    });
  }

  private async vehicleForDocument(
    tx: Prisma.TransactionClient,
    document: { id: number; tenantId: number; vehicleId?: number | null },
    vin?: string,
  ): Promise<any | null> {
    if (document.vehicleId) {
      const assigned = await tx.vehicle.findFirst({
        where: { id: document.vehicleId, tenantId: document.tenantId },
      });
      if (!assigned) return null;
      if (vin && normalizeVin(assigned.vin) !== vin) {
        this.logger.warn(
          `document ${document.id} VIN ${vin} does not match assigned vehicle ${assigned.vin}`,
        );
        await tx.document.update({
          where: { id: document.id },
          data: { needsReview: true },
        });
        return null;
      }
      return assigned;
    }
    if (!vin) return null;
    return tx.vehicle.findFirst({ where: { tenantId: document.tenantId, vin } });
  }

  private async findOrCreateExtractedSeller(
    tx: Prisma.TransactionClient,
    tenantId: number,
    canonical: CanonicalAccountingDocument,
    assignedPartyId?: number | null,
  ): Promise<number | null> {
    const taxId = normalizeEin(canonical.vendorEin);
    const identityErrors = privateSellerIdentityErrors({
      kind: canonical.vendorKind,
      country: canonical.vendorCountry,
      identifierType: canonical.vendorIdentifierType,
      taxId,
    });
    if (identityErrors.length > 0) {
      this.logger.warn(
        `contract seller identity requires review: ${identityErrors.join('; ')}`,
      );
      return null;
    }
    if (taxId) {
      const existing = await tx.party.findFirst({ where: { tenantId, taxId } });
      if (existing) {
        const seller = await tx.party.update({
          where: { id: existing.id },
          data: {
            kind: canonical.vendorKind,
            identifierType: canonical.vendorIdentifierType,
            name: canonical.vendor || existing.name,
            country: countryCode(canonical.vendorCountry, existing.country),
            isSupplier: true,
          },
        });
        return seller.id;
      }
      if (canonical.vendor) {
        const seller = await tx.party.create({
          data: {
            tenantId,
            kind: canonical.vendorKind,
            identifierType: canonical.vendorIdentifierType,
            name: canonical.vendor,
            taxId,
            country: countryCode(canonical.vendorCountry, 'RO'),
            isSupplier: true,
          },
        });
        return seller.id;
      }
    }
    if (assignedPartyId) {
      const assigned = await tx.party.findFirst({
        where: { id: assignedPartyId, tenantId },
        select: { id: true },
      });
      if (assigned) {
        await tx.party.update({
          where: { id: assigned.id },
          data: { isSupplier: true },
        });
        return assigned.id;
      }
    }
    return null;
  }

  private async attachRelatedDocuments(
    tenantId: number,
    vehicleId: number,
    rawVin: string,
    sourceDocumentId: number,
  ) {
    const vin = normalizeVin(rawVin);
    if (!vin) return;
    const candidates = await this.prisma.document.findMany({
      where: {
        tenantId,
        id: { not: sourceDocumentId },
        vehicleId: null,
        deletedAt: null,
        type: {
          in: [
            'Contract',
            'CMR',
            'Invoice',
            'Receipt',
            'Vehicle Registration Certificate',
          ],
        },
        processedData: { isNot: null },
      },
      include: { processedData: true },
      orderBy: { uploadedAt: 'desc' },
      take: 200,
    });
    const related = candidates.filter((candidate) => {
      const fields = unwrapExtractedFields(
        candidate.processedData?.extractedFields,
      );
      return extractedVin(fields) === vin;
    });
    if (related.length === 0) return;
    await this.prisma.document.updateMany({
      where: { id: { in: related.map((item) => item.id) }, tenantId },
      data: { vehicleId },
    });
    for (const contract of related.filter((item) => item.type === 'Contract')) {
      await this.sync(contract.id);
    }
  }
}

export function normalizeVin(value: unknown): string | undefined {
  const vin = cleanString(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : undefined;
}

function extractedVin(fields: Record<string, any>): string | undefined {
  return normalizeVin(
    fields.vin ?? fields.vehicle_vin ?? fields.chassis_number,
  );
}

function extractedDate(value: unknown): Date | undefined {
  const date = normalizeDate(value);
  return date ? new Date(`${date}T12:00:00.000Z`) : undefined;
}

function validVehicleYear(value: unknown): number | undefined {
  const year = Number(value);
  const max = new Date().getUTCFullYear() + 1;
  return Number.isInteger(year) && year >= 1886 && year <= max ? year : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function cleanString(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function optionalString(value: unknown): string | undefined {
  return cleanString(value) || undefined;
}

function countryCode(value: unknown, fallback: string): string {
  const country = cleanString(value).toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : fallback;
}
