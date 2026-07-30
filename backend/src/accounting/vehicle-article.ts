import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

type DbClient = Prisma.TransactionClient | PrismaService;

export interface VehicleArticleIdentity {
  vin: string;
  make?: string | null;
  model?: string | null;
  variant?: string | null;
}

/**
 * A vehicle is an individually tracked stock item. Its article code therefore
 * uses the complete VIN instead of a semantic match or a truncated suffix.
 */
export function vehicleArticleCode(value: unknown): string {
  const vin = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return vin ? `AUTO-${vin}` : '';
}

export async function ensureVehicleArticle(
  db: DbClient,
  tenantId: number,
  vehicle: VehicleArticleIdentity,
): Promise<void> {
  const code = vehicleArticleCode(vehicle.vin);
  if (!code) return;

  const existing = await db.article.findUnique({
    where: { tenantId_code: { tenantId, code } },
    select: { id: true },
  });
  if (existing) return;

  const articles = await db.article.findMany({
    where: { tenantId },
    select: { analyticCode: true },
  });
  const nextAnalytic = String(
    articles.reduce((max, article) => {
      const numeric = Number(article.analyticCode);
      return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
    }, 0) + 1,
  ).padStart(5, '0');
  const identity = [vehicle.make, vehicle.model, vehicle.variant]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ');

  await db.article.upsert({
    where: { tenantId_code: { tenantId, code } },
    update: {},
    create: {
      tenantId,
      code,
      name: [identity || 'Autoturism', `VIN ${vehicle.vin}`].join(' · '),
      analyticCode: nextAnalytic,
      vatRate: 'TWENTYONE',
      unit: 'BUCATA',
      type: 'MARFURI',
      accountCode: '371',
    },
  });
}
