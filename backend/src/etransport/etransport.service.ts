import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import PDFDocument = require('pdfkit');
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { AnafClient } from './anaf-client';
import { buildETransportXml, DeclarationData } from './xml-builder';

export interface CreateDeclarationInput {
  vehicleId?: number;
  operationType?: string;
  transporter: { name: string; taxId: string; country: string };
  vehiclePlate: string;
  trailerPlate?: string;
  loadingPlace: { country: string; county?: string; city?: string; address?: string };
  unloadingPlace: { country: string; county?: string; city?: string; address?: string };
  goods: Array<{ description: string; tariffCode?: string; weightKg?: number; valueRon?: number }>;
  transportDate?: string;
}

@Injectable()
export class EtransportService {
  private readonly logger = new Logger(EtransportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anaf: AnafClient,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * Pre-fill a declaration form from the vehicle's extracted CMR / purchase
   * invoice data, so the user only confirms/edits.
   */
  async prefill(tenantId: number, vehicleId: number) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, tenantId },
      include: {
        seller: true,
        documents: {
          where: { deletedAt: null, type: { in: ['CMR', 'Invoice'] } },
          include: { processedData: true },
          orderBy: { uploadedAt: 'desc' },
        },
      },
    });
    if (!vehicle) throw new NotFoundException('Vehiculul nu a fost găsit');

    const cmr = vehicle.documents.find((d) => d.type === 'CMR')?.processedData?.extractedFields as
      | Record<string, any>
      | undefined;
    const invoice = vehicle.documents.find((d) => d.type === 'Invoice')?.processedData?.extractedFields as
      | Record<string, any>
      | undefined;

    return {
      vehicleId,
      operationType: 'AIC',
      transporter: {
        name: cmr?.carrier_name ?? '',
        taxId: cmr?.carrier_tax_id ?? '',
        country: cmr?.carrier_country ?? vehicle.originCountry,
      },
      vehiclePlate: cmr?.vehicle_plate ?? '',
      trailerPlate: cmr?.trailer_plate ?? '',
      loadingPlace: {
        country: vehicle.originCountry,
        city: cmr?.place_of_loading ?? '',
        address: '',
      },
      unloadingPlace: { country: 'RO', county: '', city: cmr?.place_of_delivery ?? '', address: '' },
      goods: [
        {
          description: `Autoturism ${vehicle.make} ${vehicle.model}, VIN ${vehicle.vin}`,
          tariffCode: '8703',
          weightKg: 1500,
          valueRon: invoice?.total_amount != null ? Math.round(Number(invoice.total_amount) * 5) : undefined,
        },
      ],
    };
  }

  async create(tenantId: number, input: CreateDeclarationInput) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const data: DeclarationData = {
      tenantCui: tenant?.cui ?? '0000000000000',
      operationType: input.operationType ?? 'AIC',
      transporter: input.transporter,
      vehiclePlate: input.vehiclePlate,
      trailerPlate: input.trailerPlate,
      loadingPlace: input.loadingPlace,
      unloadingPlace: input.unloadingPlace,
      goods: input.goods,
      transportDate: input.transportDate,
    };
    const xml = buildETransportXml(data);

    return this.prisma.eTransportDeclaration.create({
      data: {
        tenantId,
        vehicleId: input.vehicleId,
        operationType: data.operationType,
        status: 'DRAFT',
        xmlPayload: xml,
        transporter: input.transporter as any,
        vehiclePlate: input.vehiclePlate,
        trailerPlate: input.trailerPlate,
        loadingPlace: input.loadingPlace as any,
        unloadingPlace: input.unloadingPlace as any,
        goods: input.goods as any,
      },
    });
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

    const uploadId = await this.anaf.submitDeclaration(tenantId, tenant.cui, decl.xmlPayload);

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

  /** Poll ANAF for SUBMITTED declarations until the UIT (or a rejection) arrives. */
  @Cron('0 */2 * * * *')
  async pollStatuses() {
    if (!this.anaf.configured) return;
    const pending = await this.prisma.eTransportDeclaration.findMany({
      where: { status: 'SUBMITTED', anafUploadId: { not: null } },
      take: 20,
    });
    for (const decl of pending) {
      try {
        const result = await this.anaf.checkStatus(decl.tenantId, decl.anafUploadId!);
        if (result.status === 'CONFIRMED') {
          await this.prisma.eTransportDeclaration.update({
            where: { id: decl.id },
            data: {
              status: 'CONFIRMED',
              uit: result.uit,
              anafResponse: { raw: result.raw } as any,
              validFrom: new Date(),
              validUntil: new Date(Date.now() + 5 * 24 * 3600 * 1000),
            },
          });
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

  /** Printable UIT sheet the driver carries with the transport. */
  async uitSheet(tenantId: number, id: number): Promise<Buffer> {
    const decl = await this.get(tenantId, id);
    if (!decl.uit) throw new BadRequestException('Declarația nu are încă un cod UIT');
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
