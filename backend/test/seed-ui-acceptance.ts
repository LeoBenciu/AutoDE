import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import PDFDocument = require('pdfkit');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { S3Service } from '../src/common/s3.service';
import { accountingFields, cleanupTenant } from './test-helpers';

const TENANT_NAME = '__AUTOIMPORT_UI_ACCEPTANCE__';
export const UI_ACCEPTANCE_EMAIL = 'ui-acceptance@autoimport.test';
export const UI_ACCEPTANCE_PASSWORD = 'UiAcceptance!2026';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const prisma = app.get(PrismaService);
  const s3 = app.get(S3Service);
  try {
    const existing = await prisma.tenant.findFirst({
      where: { name: TENANT_NAME },
      select: { id: true },
    });
    if (existing) await cleanupTenant(prisma, existing.id, s3);
    if (process.argv.includes('--cleanup')) {
      console.log('UI acceptance fixture removed.');
      return;
    }

    const tenant = await prisma.tenant.create({
      data: {
        name: TENANT_NAME,
        cui: '50675950',
        registrationNumber: 'J40/100/2026',
        address: 'Bd. Unirii 1',
        city: 'București',
        county: 'B',
        isVatPayer: true,
        accountingCutoverAt: new Date('2026-01-01T00:00:00.000Z'),
        sagaExportConfig: {
          from: '2026-07-01',
          to: '2026-07-31',
          preset: 'custom',
          types: ['furnizori', 'clienti', 'articole'],
        },
      },
    });
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        name: 'Ana Acceptance',
        email: UI_ACCEPTANCE_EMAIL,
        passwordHash: await bcrypt.hash(UI_ACCEPTANCE_PASSWORD, 4),
        role: 'OWNER',
      },
    });
    const party = await prisma.party.create({
      data: {
        tenantId: tenant.id,
        kind: 'COMPANY',
        name: 'Client UI Acceptance SRL',
        taxId: '87654321',
        isSupplier: true,
        isClient: true,
        supplierCode: 'FURN-UI',
        clientCode: 'CLI-UI',
        supplierAnalytic: '00001',
        clientAnalytic: '00001',
        registration: 'J40/200/2026',
        country: 'RO',
        county: 'B',
        city: 'București',
        address: 'Str. Browser 10',
      },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        tenantId: tenant.id,
        vin: 'WVWZZZ1JZXW000001',
        make: 'Volkswagen',
        model: 'Golf Acceptance',
        year: 2022,
        purchasePrice: 12000,
        purchaseCurrency: 'EUR',
        listPrice: 16500,
        status: 'IN_TRANSIT',
        sellerId: party.id,
      },
    });
    await prisma.article.create({
      data: {
        tenantId: tenant.id,
        code: 'ART-UI',
        name: 'Servicii acceptanță',
        analyticCode: '00001',
        vatRate: 'TWENTYONE',
        unit: 'UNITATE_DE_SERVICE',
        type: 'SERVICII_VANDUTE',
        accountCode: '628',
      },
    });

    const pdf = await renderFixturePdf();
    const key = `tenants/${tenant.id}/acceptance/ui-acceptance.pdf`;
    // Selector-only browser runs can skip object storage on constrained local
    // machines. Full CI leaves this unset and still exercises the real PDF.
    if (process.env.UI_ACCEPTANCE_SKIP_DOCUMENT_STORAGE !== 'true') {
      await s3.putObject(key, pdf, 'application/pdf');
    }
    const document = await prisma.document.create({
      data: {
        tenantId: tenant.id,
        vehicleId: vehicle.id,
        partyId: party.id,
        name: 'UI Acceptance Invoice.pdf',
        type: 'Invoice',
        s3Key: key,
        contentType: 'application/pdf',
        fileSize: pdf.length,
        documentHash: createHash('sha256').update(pdf).digest('hex'),
        processingStatus: 'COMPLETED',
        reviewStatus: 'PENDING_APPROVAL',
        needsReview: true,
        uploadedAt: new Date('2026-07-20T10:00:00.000Z'),
        processedData: {
          create: {
            documentType: 'Invoice',
            typeConfidence: 0.98,
            extractedFields: {
              ...accountingFields(tenant.name, tenant.cui!, 'UI-INV-001'),
              vendor_address: 'Str. Furnizorului 1',
              payment_method: 'bank',
              document_hash: 'internal-document-hash-must-not-render',
            },
            fieldConfidence: {
              vendor: 0.98,
              document_number: 0.99,
              total_amount: 0.97,
              line_items: 0.92,
            },
            validationIssues: [],
          },
        },
      },
    });
    await prisma.contract.create({
      data: {
        tenantId: tenant.id,
        vehicleId: vehicle.id,
        partyId: party.id,
        direction: 'OUTGOING',
        contractType: 'vanzare-cumparare',
        contractNumber: 'CV-UI-00001',
        contractDate: new Date('2026-07-20T10:00:00.000Z'),
        totalValue: 16500,
        currency: 'EUR',
        documentId: document.id,
      },
    });
    await prisma.eTransportDeclaration.create({
      data: {
        tenantId: tenant.id,
        vehicleId: vehicle.id,
        operationType: 'AIC',
        status: 'DRAFT',
        transportDate: new Date('2026-07-28T00:00:00.000Z'),
        dataVerifiedAt: new Date(),
        xmlPayload: '<eTransport />',
        transporter: {
          name: 'Transport UI SRL',
          taxId: 'DE12345',
          country: 'DE',
        },
        vehiclePlate: 'B123UIT',
        loadingPlace: { country: 'DE', city: 'Berlin' },
        unloadingPlace: { country: 'RO', county: 'B', city: 'București' },
        goods: [
          {
            description: 'Volkswagen Golf Acceptance',
            tariffCode: '87032390',
            weightKg: 1327,
            valueWithoutVat: 60000,
            currency: 'RON',
            valueRon: 60000,
          },
        ],
      },
    });
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        action: 'acceptance.fixture_created',
        entity: 'Tenant',
        entityId: tenant.id,
      },
    });

    console.log(
      JSON.stringify({
        tenantId: tenant.id,
        documentId: document.id,
        email: UI_ACCEPTANCE_EMAIL,
        password: UI_ACCEPTANCE_PASSWORD,
      }),
    );
  } finally {
    await app.close();
  }
}

function renderFixturePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(20).text('FACTURĂ UI ACCEPTANCE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).text('Furnizor: Furnizor Acceptance SRL');
    doc.text('Client: AutoImport UI Acceptance');
    doc.text('Număr: UI-INV-001');
    doc.text('Total: 121,00 RON');
    doc.end();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
