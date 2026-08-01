import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { S3Service } from '../common/s3.service';
import { AuditService } from '../common/audit.service';
import { amountInWords } from './ro-words';
import { renderContractPdf } from './contract-pdf';
import {
  CONTRACT_PLACEHOLDERS,
  ContractKind,
  ContractTemplateData,
  DEFAULT_HANDOVER_PROTOCOL_TEMPLATE,
  DEFAULT_SALE_CONTRACT_TEMPLATE,
  defaultTemplateFor,
  misplacedBlockPlaceholders,
  unknownTemplatePlaceholders,
} from './contract-templates';

interface GenerateInput {
  vehicleId: number;
  buyerId: number;
  kind: ContractKind;
  price?: number;
  currency?: string;
}

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: number, vehicleId?: number) {
    return this.prisma.contract.findMany({
      where: { tenantId, ...(vehicleId ? { vehicleId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: {
        vehicle: { select: { id: true, vin: true, make: true, model: true } },
        party: { select: { id: true, name: true } },
        document: { select: { id: true, name: true } },
      },
    });
  }

  async templates(tenantId: number) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        saleContractTemplate: true,
        handoverProtocolTemplate: true,
      },
    });
    if (!tenant) throw new NotFoundException('Compania nu a fost găsită');
    return {
      templates: {
        sale:
          tenant.saleContractTemplate ?? DEFAULT_SALE_CONTRACT_TEMPLATE,
        handover:
          tenant.handoverProtocolTemplate ??
          DEFAULT_HANDOVER_PROTOCOL_TEMPLATE,
      },
      defaults: {
        sale: DEFAULT_SALE_CONTRACT_TEMPLATE,
        handover: DEFAULT_HANDOVER_PROTOCOL_TEMPLATE,
      },
      customized: {
        sale: tenant.saleContractTemplate != null,
        handover: tenant.handoverProtocolTemplate != null,
      },
      placeholders: CONTRACT_PLACEHOLDERS,
    };
  }

  async updateTemplates(
    tenantId: number,
    userId: number,
    input: { sale?: string; handover?: string },
  ) {
    const data: {
      saleContractTemplate?: string | null;
      handoverProtocolTemplate?: string | null;
    } = {};
    if (input.sale !== undefined) {
      data.saleContractTemplate = this.customTemplateOrNull(
        input.sale,
        DEFAULT_SALE_CONTRACT_TEMPLATE,
      );
    }
    if (input.handover !== undefined) {
      data.handoverProtocolTemplate = this.customTemplateOrNull(
        input.handover,
        DEFAULT_HANDOVER_PROTOCOL_TEMPLATE,
      );
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nu a fost trimis niciun șablon');
    }

    await this.prisma.tenant.update({ where: { id: tenantId }, data });
    await this.audit.log({
      tenantId,
      userId,
      action: 'contract.templates.updated',
      entity: 'Tenant',
      entityId: tenantId,
      details: {
        saleCustomized: data.saleContractTemplate != null,
        handoverCustomized: data.handoverProtocolTemplate != null,
      },
    });
    return this.templates(tenantId);
  }

  async previewTemplate(kind: ContractKind, template?: string) {
    const selected = template?.trim() || defaultTemplateFor(kind);
    this.validateTemplate(selected);
    const pdf = await renderContractPdf(selected, previewData(kind));
    return {
      contentType: 'application/pdf',
      fileName:
        kind === 'vanzare-cumparare'
          ? 'previzualizare-contract.pdf'
          : 'previzualizare-proces-verbal.pdf',
      data: pdf.toString('base64'),
    };
  }

  async regenerate(tenantId: number, userId: number, id: number) {
    const contract = await this.prisma.contract.findFirst({
      where: { id, tenantId },
      include: {
        vehicle: { include: { tenant: true } },
        party: true,
        document: true,
      },
    });
    if (!contract) throw new NotFoundException('Contractul nu a fost găsit');
    if (
      !contract.document ||
      !contract.vehicle ||
      !['vanzare-cumparare', 'proces-verbal'].includes(contract.contractType)
    ) {
      throw new BadRequestException(
        'Doar contractele și procesele-verbale generate de aplicație pot fi regenerate',
      );
    }

    const kind = contract.contractType as ContractKind;
    const template = this.templateFor(kind, contract.vehicle.tenant);
    this.validateTemplate(template);
    const price =
      contract.totalValue == null ? undefined : Number(contract.totalValue);
    const data = this.templateData(
      contract.vehicle,
      contract.party,
      contract.contractNumber ?? String(contract.id),
      (contract.contractDate ?? contract.document.uploadedAt).toLocaleDateString(
        'ro-RO',
      ),
      price,
      contract.currency ?? contract.vehicle.soldCurrency ?? 'RON',
    );
    const pdf = await renderContractPdf(template, data);
    await this.s3.putObject(contract.document.s3Key, pdf, 'application/pdf');
    await this.prisma.document.update({
      where: { id: contract.document.id },
      data: {
        contentType: 'application/pdf',
        fileSize: pdf.length,
        documentHash: createHash('sha256').update(pdf).digest('hex'),
        processingStatus: 'COMPLETED',
      },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'contract.regenerated',
      entity: 'Contract',
      entityId: contract.id,
      details: {
        contractNumber: contract.contractNumber,
        kind,
        documentId: contract.document.id,
      },
    });
    return { contract, documentId: contract.document.id };
  }

  /**
   * Generates a Romanian contract PDF from vehicle + party data, stores it
   * through the document store (attached to the vehicle) and records the
   * contract with a per-tenant number sequence.
   */
  async generate(tenantId: number, userId: number, input: GenerateInput) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, tenantId },
      include: { tenant: true },
    });
    if (!vehicle) throw new NotFoundException('Vehiculul nu a fost găsit');

    const buyer = await this.prisma.party.findFirst({ where: { id: input.buyerId, tenantId } });
    if (!buyer) throw new NotFoundException('Cumpărătorul nu a fost găsit');

    const price = input.price ?? (vehicle.soldPrice != null ? Number(vehicle.soldPrice) : undefined);
    if (input.kind === 'vanzare-cumparare' && price == null) {
      throw new BadRequestException('Prețul de vânzare lipsește — setează-l pe vehicul sau trimite-l explicit');
    }
    const currency = input.currency ?? vehicle.soldCurrency ?? 'RON';

    const series = input.kind === 'vanzare-cumparare' ? 'CV' : 'PV';
    const number = await this.nextNumber(tenantId, series);
    const contractNumber = `${series}-${String(number).padStart(5, '0')}`;
    const today = new Date();

    const template = this.templateFor(input.kind, vehicle.tenant);
    this.validateTemplate(template);
    const templateData = this.templateData(
      vehicle,
      buyer,
      contractNumber,
      today.toLocaleDateString('ro-RO'),
      price,
      currency,
    );
    const pdf = await renderContractPdf(template, templateData);

    const fileName = `${contractNumber}_${vehicle.vin}.pdf`;
    const s3Key = `tenants/${tenantId}/contracts/${randomUUID()}/${fileName}`;
    await this.s3.putObject(s3Key, pdf, 'application/pdf');

    const document = await this.prisma.document.create({
      data: {
        name: fileName,
        type: input.kind === 'vanzare-cumparare' ? 'Sale Contract' : 'Handover Protocol',
        s3Key,
        contentType: 'application/pdf',
        fileSize: pdf.length,
        documentHash: createHash('sha256').update(pdf).digest('hex'),
        tenantId,
        vehicleId: vehicle.id,
        partyId: buyer.id,
        processingStatus: 'COMPLETED',
      },
    });

    const contract = await this.prisma.contract.create({
      data: {
        tenantId,
        vehicleId: vehicle.id,
        partyId: buyer.id,
        direction: 'OUTGOING',
        contractType: input.kind,
        contractNumber,
        contractDate: today,
        totalValue: price,
        currency,
        documentId: document.id,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: 'contract.generated',
      entity: 'Contract',
      entityId: contract.id,
      details: { contractNumber, kind: input.kind, vehicleId: vehicle.id },
    });

    return { contract, documentId: document.id };
  }

  private async nextNumber(tenantId: number, series: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await tx.contractNumberSequence.upsert({
        where: { tenantId_series: { tenantId, series } },
        create: { tenantId, series, nextNumber: 2 },
        update: { nextNumber: { increment: 1 } },
      });
      // On create the reserved number is 1; on update it's the pre-increment value.
      return seq.nextNumber - 1;
    });
  }

  private templateFor(
    kind: ContractKind,
    tenant: {
      saleContractTemplate?: string | null;
      handoverProtocolTemplate?: string | null;
    },
  ) {
    return kind === 'vanzare-cumparare'
      ? tenant.saleContractTemplate ?? DEFAULT_SALE_CONTRACT_TEMPLATE
      : tenant.handoverProtocolTemplate ?? DEFAULT_HANDOVER_PROTOCOL_TEMPLATE;
  }

  private templateData(
    vehicle: any,
    buyer: any,
    contractNumber: string,
    date: string,
    price: number | undefined,
    currency: string,
  ): ContractTemplateData {
    return {
      contractNumber,
      date,
      seller: {
        name: vehicle.tenant.name,
        taxId: vehicle.tenant.cui,
        registration: vehicle.tenant.registrationNumber,
        address: vehicle.tenant.address,
        city: vehicle.tenant.city,
        county: vehicle.tenant.county,
        country: vehicle.tenant.country,
        iban: vehicle.tenant.iban,
        bankName: vehicle.tenant.bankName,
        email: vehicle.tenant.email,
        phone: vehicle.tenant.phone,
      },
      buyer: {
        name: buyer.name,
        taxId: buyer.taxId,
        identifierType: buyer.identifierType,
        registration: buyer.registration,
        address: buyer.address,
        city: buyer.city,
        county: buyer.county,
        country: buyer.country,
        iban: buyer.iban,
        bankName: buyer.bankName,
        email: buyer.email,
        phone: buyer.phone,
        kind: buyer.kind,
      },
      vehicle: {
        make: vehicle.make,
        model: vehicle.model,
        variant: vehicle.variant ?? '',
        vin: vehicle.vin,
        year: vehicle.year,
        firstRegistered:
          vehicle.firstRegistered?.toLocaleDateString('ro-RO') ?? null,
        mileageKm: vehicle.mileageKm,
        color: vehicle.color,
      },
      price,
      currency,
      priceInWords:
        price == null ? undefined : amountInWords(price, currency),
    };
  }

  private customTemplateOrNull(template: string, defaultTemplate: string) {
    const normalized = template.trim();
    if (!normalized) {
      throw new BadRequestException('Șablonul nu poate fi gol');
    }
    this.validateTemplate(normalized);
    return normalized === defaultTemplate.trim() ? null : normalized;
  }

  private validateTemplate(template: string) {
    if (template.length > 30_000) {
      throw new BadRequestException(
        'Șablonul este prea lung (maximum 30.000 de caractere)',
      );
    }
    const unknown = unknownTemplatePlaceholders(template);
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Placeholder necunoscut: ${unknown.join(', ')}`,
      );
    }
    const misplaced = misplacedBlockPlaceholders(template);
    if (misplaced.length > 0) {
      throw new BadRequestException(
        `Placeholder-ele bloc trebuie puse singure pe rând: ${misplaced.join(', ')}`,
      );
    }
  }
}

function previewData(kind: ContractKind): ContractTemplateData {
  return {
    contractNumber: kind === 'vanzare-cumparare' ? 'CV-00001' : 'PV-00001',
    date: '01.08.2026',
    seller: {
      name: 'DEALER AUTO ROMÂNIA S.R.L.',
      taxId: 'RO12345678',
      registration: 'J40/1234/2020',
      address: 'Str. Independenței nr. 10, bl. A2, et. 1, ap. 4',
      city: 'București',
      county: 'București',
      country: 'RO',
      iban: 'RO49AAAA1B31007593840000',
      bankName: 'Banca Exemplu',
      email: 'vanzari@dealer-exemplu.ro',
      phone: '+40 721 000 000',
    },
    buyer: {
      name: 'Șerban-Țăndărică Ionuț',
      kind: 'INDIVIDUAL',
      identifierType: 'CNP',
      taxId: '1900101223344',
      address: 'Str. Mărășești nr. 25, sat Pâncești, comuna Sascut',
      city: 'Sascut',
      county: 'Bacău',
      country: 'RO',
    },
    vehicle: {
      make: 'Volkswagen',
      model: 'Passat',
      variant: 'Variant B8 2.0 TDI',
      vin: 'WVWZZZ3CZJE000000',
      year: 2018,
      firstRegistered: '15.03.2018',
      mileageKm: 145_320,
      color: 'Gri metalizat',
    },
    price: 100_000,
    currency: 'RON',
    priceInWords: amountInWords(100_000, 'RON'),
  };
}
