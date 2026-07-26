import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { lookupAnafCompany } from './anaf-company';
import { PostingService } from './posting.service';

const DEFAULT_ACCOUNTS = [
  ['2133', 'Mijloace de transport', 'ASSET'],
  ['371', 'Mărfuri', 'ASSET'],
  ['401', 'Furnizori', 'LIABILITY'],
  ['409', 'Furnizori - debitori', 'ASSET'],
  ['411', 'Clienți', 'ASSET'],
  ['419', 'Clienți - creditori', 'LIABILITY'],
  ['4426', 'TVA deductibilă', 'ASSET'],
  ['4427', 'TVA colectată', 'LIABILITY'],
  ['5121', 'Conturi la bănci în lei', 'ASSET'],
  ['5124', 'Conturi la bănci în valută', 'ASSET'],
  ['5311', 'Casa în lei', 'ASSET'],
  ['6022', 'Cheltuieli privind combustibilii', 'EXPENSE'],
  ['611', 'Cheltuieli cu întreținerea și reparațiile', 'EXPENSE'],
  ['612', 'Cheltuieli cu redevențele, locațiile și chiriile', 'EXPENSE'],
  ['624', 'Cheltuieli cu transportul de bunuri și personal', 'EXPENSE'],
  ['628', 'Alte cheltuieli cu serviciile executate de terți', 'EXPENSE'],
  ['701', 'Venituri din vânzarea produselor finite', 'INCOME'],
  ['704', 'Venituri din servicii prestate', 'INCOME'],
  ['706', 'Venituri din redevențe, locații și chirii', 'INCOME'],
  ['707', 'Venituri din vânzarea mărfurilor', 'INCOME'],
] as const;

@Injectable()
export class AccountingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  async onModuleInit() {
    await this.prisma.chartOfAccount
      .createMany({
        data: DEFAULT_ACCOUNTS.map(([accountCode, accountName, accountType]) => ({
          accountCode,
          accountName,
          accountType,
        })),
        skipDuplicates: true,
      })
      .catch(() => undefined);
  }

  async company(tenantId: number) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Compania nu a fost găsită');
    return tenant;
  }

  companyFromAnaf(cui: string, requestId?: string) {
    return lookupAnafCompany(cui, { requestId });
  }

  async updateCompany(tenantId: number, values: Record<string, unknown>) {
    const allowed = [
      'name',
      'cui',
      'registrationNumber',
      'address',
      'country',
      'county',
      'city',
      'iban',
      'bankName',
      'email',
      'phone',
      'defaultCurrency',
      'isVatPayer',
      'hasTvaLaIncasare',
    ];
    const data = Object.fromEntries(
      allowed
        .filter((key) => Object.prototype.hasOwnProperty.call(values, key))
        .map((key) => [key, normalizeCompanyValue(key, values[key])]),
    );
    return this.prisma.tenant.update({ where: { id: tenantId }, data });
  }

  ledger(
    tenantId: number,
    filters: Parameters<PostingService['listLedger']>[1],
  ) {
    return this.posting.listLedger(tenantId, filters);
  }

  accounts(search?: string) {
    return this.prisma.chartOfAccount.findMany({
      where: {
        active: true,
        ...(search
          ? {
              OR: [
                { accountCode: { contains: search } },
                {
                  accountName: {
                    contains: search,
                    mode: 'insensitive' as const,
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: { accountCode: 'asc' },
      take: 500,
    });
  }

  articles(tenantId: number, search?: string) {
    return this.prisma.article.findMany({
      where: {
        tenantId,
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' as const } },
                { name: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ code: 'asc' }, { name: 'asc' }],
    });
  }

  createArticle(tenantId: number, values: Record<string, unknown>) {
    return this.prisma.article.create({
      data: {
        tenantId,
        code: requiredString(values.code, 'Codul articolului este obligatoriu'),
        name: requiredString(values.name, 'Denumirea articolului este obligatorie'),
        analyticCode: optionalString(values.analyticCode),
        vatRate: optionalString(values.vatRate) ?? 'TWENTYONE',
        unit: optionalString(values.unit) ?? 'BUCATA',
        type: optionalString(values.type) ?? 'MARFURI',
        accountCode: optionalString(values.accountCode),
        management: optionalString(values.management),
      },
    });
  }

  async updateArticle(
    tenantId: number,
    id: number,
    values: Record<string, unknown>,
  ) {
    const article = await this.prisma.article.findFirst({ where: { id, tenantId } });
    if (!article) throw new NotFoundException('Articolul nu a fost găsit');
    return this.prisma.article.update({
      where: { id },
      data: articleValues(values),
    });
  }

  managements(tenantId: number) {
    return this.prisma.management.findMany({
      where: { tenantId },
      orderBy: { code: 'asc' },
    });
  }

  createManagement(tenantId: number, values: Record<string, unknown>) {
    return this.prisma.management.create({
      data: {
        tenantId,
        code: requiredString(values.code, 'Codul gestiunii este obligatoriu'),
        name: requiredString(values.name, 'Denumirea gestiunii este obligatorie'),
        type: optionalString(values.type) ?? 'CANTITATIV_VALORICA',
        analyticCode: optionalString(values.analyticCode),
      },
    });
  }

  async updateManagement(
    tenantId: number,
    id: number,
    values: Record<string, unknown>,
  ) {
    const management = await this.prisma.management.findFirst({
      where: { id, tenantId },
    });
    if (!management) throw new NotFoundException('Gestiunea nu a fost găsită');
    return this.prisma.management.update({
      where: { id },
      data: {
        ...(values.code !== undefined ? { code: String(values.code).trim() } : {}),
        ...(values.name !== undefined ? { name: String(values.name).trim() } : {}),
        ...(values.type !== undefined ? { type: String(values.type).trim() } : {}),
        ...(values.analyticCode !== undefined
          ? { analyticCode: optionalString(values.analyticCode) }
          : {}),
      },
    });
  }
}

function articleValues(values: Record<string, unknown>) {
  const keys = [
    'code',
    'name',
    'analyticCode',
    'vatRate',
    'unit',
    'type',
    'accountCode',
    'management',
  ];
  return Object.fromEntries(
    keys
      .filter((key) => values[key] !== undefined)
      .map((key) => [key, optionalString(values[key])]),
  );
}

function normalizeCompanyValue(key: string, value: unknown): unknown {
  if (key === 'isVatPayer' || key === 'hasTvaLaIncasare') return value === true;
  const string = optionalString(value);
  if (key === 'country') return (string ?? 'RO').toUpperCase();
  if (key === 'defaultCurrency') return (string ?? 'RON').toUpperCase();
  return string;
}

function optionalString(value: unknown): string | null {
  const string = value == null ? '' : String(value).trim();
  return string || null;
}

function requiredString(value: unknown, message: string): string {
  const string = optionalString(value);
  if (!string) throw new Error(message);
  return string;
}
