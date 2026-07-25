import { PrismaService } from '../src/common/prisma.service';
import { S3Service } from '../src/common/s3.service';

export async function cleanupTenant(
  prisma: PrismaService,
  tenantId: number,
  s3?: S3Service,
): Promise<void> {
  const documents = await prisma.document.findMany({
    where: { tenantId },
    select: { id: true, s3Key: true },
  });
  const pending = await prisma.pendingUpload.findMany({
    where: { tenantId },
    select: { s3Key: true },
  });
  const documentIds = documents.map((document) => document.id);
  const vehicleIds = (
    await prisma.vehicle.findMany({
      where: { tenantId },
      select: { id: true },
    })
  ).map((vehicle) => vehicle.id);

  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { tenantId } }),
    prisma.documentRelationship.deleteMany({
      where: {
        OR: [
          { parentId: { in: documentIds } },
          { childId: { in: documentIds } },
        ],
      },
    }),
    prisma.generalLedgerEntry.deleteMany({ where: { tenantId } }),
    prisma.eTransportDeclaration.deleteMany({ where: { tenantId } }),
    prisma.contract.deleteMany({ where: { tenantId } }),
    prisma.vehicleCost.deleteMany({ where: { vehicleId: { in: vehicleIds } } }),
    prisma.userCorrection.deleteMany({ where: { tenantId } }),
    prisma.processedData.deleteMany({
      where: { documentId: { in: documentIds } },
    }),
    prisma.document.deleteMany({ where: { tenantId } }),
    prisma.pendingUpload.deleteMany({ where: { tenantId } }),
    prisma.vehicle.deleteMany({ where: { tenantId } }),
    prisma.article.deleteMany({ where: { tenantId } }),
    prisma.management.deleteMany({ where: { tenantId } }),
    prisma.refreshToken.deleteMany({
      where: { user: { tenantId } },
    }),
    prisma.user.deleteMany({ where: { tenantId } }),
    prisma.party.deleteMany({ where: { tenantId } }),
    prisma.contractNumberSequence.deleteMany({ where: { tenantId } }),
    prisma.anafToken.deleteMany({ where: { tenantId } }),
  ]);
  await prisma.tenant.deleteMany({ where: { id: tenantId } });

  if (s3) {
    const keys = new Set([
      ...documents.map((document) => document.s3Key),
      ...pending.map((upload) => upload.s3Key),
    ]);
    await Promise.all(
      [...keys].map((key) => s3.deleteObject(key).catch(() => undefined)),
    );
  }
}

export function accountingFields(
  companyName: string,
  companyCui: string,
  number: string,
) {
  return {
    document_type: 'Invoice',
    direction: 'incoming',
    vendor: 'Furnizor Acceptance SRL',
    vendor_ein: '9012345',
    buyer: companyName,
    buyer_ein: companyCui,
    document_number: number,
    document_date: '2026-07-20',
    due_date: '2026-08-20',
    total_amount: 121,
    net_amount: 100,
    vat_amount: 21,
    currency: 'RON',
    line_items: [
      {
        name: 'Servicii acceptanță',
        quantity: 1,
        unit_price: 100,
        line_total: 100,
        vat_amount: 21,
        vat: 'TWENTYONE',
        account_code: '628',
        articleCode: 'ACCEPT',
        um: 'UNITATE_DE_SERVICE',
        vat_deductibility: 'FULL',
      },
    ],
  };
}
