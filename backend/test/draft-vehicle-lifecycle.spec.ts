import assert from 'node:assert/strict';
import { PrismaService } from '../src/common/prisma.service';
import { DocumentDomainSyncService } from '../src/documents/document-domain-sync.service';
import { DocumentsService } from '../src/documents/documents.service';
import { cleanupTenant } from './test-helpers';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const domainSync = new DocumentDomainSyncService(prisma);
  const documents = new DocumentsService(
    prisma,
    {} as any,
    { log: async () => undefined } as any,
    {} as any,
    domainSync,
  );
  const marker = `draft-vehicle-${Date.now()}`;
  const tenant = await prisma.tenant.create({
    data: { name: marker, cui: String(Date.now()).slice(-8) },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      name: 'Draft Vehicle Test',
      email: `${marker}@example.test`,
      passwordHash: 'not-used',
      role: 'ACCOUNTANT',
    },
  });

  try {
    const vin = 'WBAZZZ1JZXW000099';
    const source = await createPurchaseDraft(prisma, tenant.id, marker, vin);
    const cost = await prisma.document.create({
      data: {
        tenantId: tenant.id,
        name: `${marker}-cost.pdf`,
        type: 'Invoice',
        s3Key: `test/${marker}-cost.pdf`,
        contentType: 'application/pdf',
        fileSize: 1,
        documentHash: `${marker}-cost`,
        processingStatus: 'COMPLETED',
        reviewStatus: 'PENDING_APPROVAL',
        needsReview: true,
        processedData: {
          create: {
            documentType: 'Invoice',
            extractedFields: {
              direction: 'incoming',
              vehicle_transaction: 'cost',
              vin,
              total_amount: 100,
              currency: 'EUR',
              line_items: [],
            },
          },
        },
      },
    });

    const draftSync = await domainSync.syncDraftVehicle(source.id);
    assert.ok(draftSync.vehicleId);
    const provisional = await prisma.vehicle.findUniqueOrThrow({
      where: { id: draftSync.vehicleId },
    });
    assert.equal(provisional.draftSourceDocumentId, source.id);
    assert.equal(
      (
        await prisma.document.findUniqueOrThrow({ where: { id: cost.id } })
      ).vehicleId,
      provisional.id,
    );

    await documents.softDelete(tenant.id, source.id, user.id);
    assert.equal(
      await prisma.vehicle.findUnique({ where: { id: provisional.id } }),
      null,
    );
    assert.equal(
      (
        await prisma.document.findUniqueOrThrow({ where: { id: cost.id } })
      ).vehicleId,
      null,
    );

    const permanentVin = 'WVWZZZ1JZXW000098';
    const permanentSource = await createPurchaseDraft(
      prisma,
      tenant.id,
      `${marker}-permanent`,
      permanentVin,
    );
    const permanentSync = await domainSync.syncDraftVehicle(permanentSource.id);
    assert.ok(permanentSync.vehicleId);
    await prisma.document.update({
      where: { id: permanentSource.id },
      data: { reviewStatus: 'APPROVED' },
    });
    await domainSync.sync(permanentSource.id);
    assert.equal(
      (
        await prisma.vehicle.findUniqueOrThrow({
          where: { id: permanentSync.vehicleId },
        })
      ).draftSourceDocumentId,
      null,
    );

    console.log('draft-vehicle-lifecycle.spec.ts passed');
  } finally {
    await cleanupTenant(prisma, tenant.id);
    await prisma.$disconnect();
  }
}

function createPurchaseDraft(
  prisma: PrismaService,
  tenantId: number,
  marker: string,
  vin: string,
) {
  return prisma.document.create({
    data: {
      tenantId,
      name: `${marker}.pdf`,
      type: 'Contract',
      s3Key: `test/${marker}.pdf`,
      contentType: 'application/pdf',
      fileSize: 1,
      documentHash: marker,
      processingStatus: 'COMPLETED',
      reviewStatus: 'PENDING_APPROVAL',
      needsReview: true,
      processedData: {
        create: {
          documentType: 'Contract',
          extractedFields: {
            document_type: 'Contract',
            direction: 'incoming',
            contract_type: 'vanzare-cumparare autoturism',
            vehicle_transaction: 'purchase',
            vin,
            vehicle_make: 'BMW',
            vehicle_model: 'X3',
            vehicle_year: 2022,
            total_value: 20_000,
            currency: 'EUR',
          },
        },
      },
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
