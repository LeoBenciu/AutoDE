import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma.service';
import { S3Service } from '../src/common/s3.service';
import { DocumentDomainSyncService } from '../src/documents/document-domain-sync.service';
import {
  accountingFields,
  cleanupTenant,
} from './test-helpers';

process.env.JWT_SECRET = 'acceptance-test-secret';
process.env.JWT_ACCESS_TTL = '15m';

async function main() {
  const app = configureApp(
    await NestFactory.create(AppModule, { logger: false }),
  );
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  const prisma = app.get(PrismaService);
  const s3 = app.get(S3Service);
  const domainSync = app.get(DocumentDomainSyncService);
  const marker = `http-acceptance-${Date.now()}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: `AutoImport ${marker}`,
      cui: String(Date.now()).slice(-8),
      accountingCutoverAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  const otherTenant = await prisma.tenant.create({
    data: { name: `${marker}-other`, cui: String(Date.now() + 1).slice(-8) },
  });
  const password = 'Acceptance!2026';
  const passwordHash = await bcrypt.hash(password, 4);
  const users = new Map<string, { email: string; id: number }>();

  try {
    for (const role of ['ACCOUNTANT', 'SALES', 'VIEWER'] as const) {
      const user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          name: `${role} Acceptance`,
          email: `${marker}-${role.toLowerCase()}@example.test`,
          passwordHash,
          role,
        },
      });
      users.set(role, { email: user.email, id: user.id });
    }
    const otherUser = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        name: 'Other Accountant',
        email: `${marker}-other@example.test`,
        passwordHash,
        role: 'ACCOUNTANT',
      },
    });

    const tokens = new Map<string, string>();
    for (const [role, user] of users) {
      const response = await request(baseUrl, '/auth/login', {
        method: 'POST',
        body: { email: user.email, password },
        expected: 201,
      });
      assert.equal(response.user.role, role);
      tokens.set(role, response.accessToken);
    }
    const otherLogin = await request(baseUrl, '/auth/login', {
      method: 'POST',
      body: { email: otherUser.email, password },
      expected: 201,
    });

    await request(baseUrl, '/saga/preview', {
      method: 'POST',
      body: {},
      expected: 401,
    });
    for (const role of ['SALES', 'VIEWER']) {
      await request(baseUrl, '/saga/preview', {
        method: 'POST',
        token: tokens.get(role),
        body: {},
        expected: 403,
      });
    }
    for (const role of ['ACCOUNTANT']) {
      await request(baseUrl, '/saga/preview', {
        method: 'POST',
        token: tokens.get(role),
        body: {},
        expected: 201,
      });
    }

    const savedPreference = {
      from: '2026-07-01',
      to: '2026-07-31',
      preset: 'custom',
      types: ['facturi', 'plati'],
    };
    await request(baseUrl, '/saga/preferences', {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      body: savedPreference,
      expected: 201,
    });
    const preference = await request(baseUrl, '/saga/preferences', {
      token: tokens.get('ACCOUNTANT'),
      expected: 200,
    });
    assert.deepEqual(preference, savedPreference);

    const party = await request(baseUrl, '/parties', {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
      body: {
        kind: 'COMPANY',
        name: 'Client Acceptance SRL',
        taxId: 'RO87654321',
        isClient: true,
        clientCode: 'CLI-ACC',
        clientAnalytic: '00001',
      },
    });
    const vehicle = await request(baseUrl, '/vehicles', {
      method: 'POST',
      token: tokens.get('SALES'),
      expected: 201,
      body: {
        vin: `WVWZZZ1JZ${String(Date.now()).slice(-8)}`.slice(0, 17),
        make: 'Volkswagen',
        model: 'Golf Acceptance',
        year: 2022,
        purchasePrice: 12000,
        purchaseCurrency: 'EUR',
      },
    });
    const vehicles = await request(
      baseUrl,
      '/vehicles?search=Golf%20Acceptance',
      {
        token: tokens.get('VIEWER'),
        expected: 200,
      },
    );
    assert.equal(vehicles.length, 1);
    assert.ok(
      await prisma.article.findUnique({
        where: {
          tenantId_code: {
            tenantId: tenant.id,
            code: `AUTO-${vehicle.vin}`,
          },
        },
      }),
      'creating a vehicle must create its full-VIN article',
    );
    await request(baseUrl, `/vehicles/${vehicle.id}/costs`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
      body: { category: 'TRANSPORT', amount: 500, currency: 'EUR' },
    });

    const registrationVin = 'WVWZZZ1JZXW000001';
    const registrationDocument = await prisma.document.create({
      data: {
        tenantId: tenant.id,
        name: 'registration-domain-sync.pdf',
        type: 'Vehicle Registration Certificate',
        s3Key: `tenants/${tenant.id}/acceptance/registration-domain-sync.pdf`,
        contentType: 'application/pdf',
        fileSize: 1,
        documentHash: `${marker}-registration-domain-sync`,
        processingStatus: 'COMPLETED',
        reviewStatus: 'PENDING_APPROVAL',
        needsReview: true,
        processedData: {
          create: {
            documentType: 'Vehicle Registration Certificate',
            extractedFields: {
              document_type: 'Vehicle Registration Certificate',
              vin: registrationVin,
              make: 'Volkswagen',
              model: 'Golf Certificate',
              variant: 'Variant certificat',
              vehicle_year: 2021,
              first_registration_date: '10-05-2021',
              fuel_type: 'Diesel',
              color: 'Albastru',
              mass_kg: 1375,
            },
          },
        },
      },
    });
    assert.deepEqual(await domainSync.sync(registrationDocument.id), {});
    assert.equal(
      await prisma.vehicle.findUnique({
        where: { tenantId_vin: { tenantId: tenant.id, vin: registrationVin } },
      }),
      null,
      'a pending extracted document must not create a vehicle',
    );
    await request(
      baseUrl,
      `/documents/${registrationDocument.id}/corrections`,
      {
        method: 'POST',
        token: tokens.get('ACCOUNTANT'),
        expected: 201,
        body: { field: 'model', newValue: 'Golf Certificate revizuit' },
      },
    );
    assert.equal(
      await prisma.vehicle.findUnique({
        where: { tenantId_vin: { tenantId: tenant.id, vin: registrationVin } },
      }),
      null,
      'saving a draft correction must not create a vehicle',
    );
    assert.equal(
      (
        await prisma.document.findUnique({
          where: { id: registrationDocument.id },
        })
      )?.vehicleId,
      null,
    );
    await request(
      baseUrl,
      `/documents/${registrationDocument.id}/approve`,
      {
        method: 'POST',
        token: tokens.get('ACCOUNTANT'),
        expected: 201,
      },
    );
    const extractedVehicle = await prisma.vehicle.findUnique({
      where: { tenantId_vin: { tenantId: tenant.id, vin: registrationVin } },
    });
    assert.equal(extractedVehicle?.make, 'Volkswagen');
    assert.equal(extractedVehicle?.model, 'Golf Certificate revizuit');
    assert.equal(extractedVehicle?.year, 2021);
    assert.equal(extractedVehicle?.fuelType, 'Diesel');
    assert.equal(
      (await prisma.document.findUnique({ where: { id: registrationDocument.id } }))?.vehicleId,
      extractedVehicle?.id,
    );
    assert.ok(
      await prisma.article.findUnique({
        where: {
          tenantId_code: {
            tenantId: tenant.id,
            code: `AUTO-${registrationVin}`,
          },
        },
      }),
      'approving a new registration VIN must create its own article',
    );

    const sellerCnp = '1800101223340';
    const purchaseContract = await prisma.document.create({
      data: {
        tenantId: tenant.id,
        name: 'private-purchase-contract.pdf',
        type: 'Contract',
        s3Key: `tenants/${tenant.id}/acceptance/private-purchase-contract.pdf`,
        contentType: 'application/pdf',
        fileSize: 1,
        documentHash: `${marker}-private-purchase-contract`,
        processingStatus: 'COMPLETED',
        reviewStatus: 'PENDING_APPROVAL',
        needsReview: true,
        processedData: {
          create: {
            documentType: 'Contract',
            extractedFields: {
              document_type: 'Contract',
              direction: 'incoming',
              contract_number: 'ACH-ACC-1',
              contract_type: 'vanzare-cumparare autoturism',
              contract_date: '20-07-2026',
              total_value: 50_000,
              currency: 'RON',
              vehicle_transaction: 'purchase',
              vin: registrationVin,
              vehicle_make: 'Volkswagen',
              vehicle_model: 'Golf Certificate',
              vehicle_year: 2021,
              parties: [
                {
                  name: 'Ion Vânzător Acceptance',
                  ein: sellerCnp,
                  role: 'vendor',
                  kind: 'INDIVIDUAL',
                  country: 'RO',
                },
                {
                  name: tenant.name,
                  ein: tenant.cui,
                  role: 'client',
                  kind: 'COMPANY',
                  country: 'RO',
                },
              ],
            },
          },
        },
      },
    });
    assert.equal(Number(extractedVehicle?.purchasePrice), 0);
    assert.equal(
      await prisma.party.count({ where: { tenantId: tenant.id, taxId: sellerCnp } }),
      0,
      'a pending contract must not create its seller',
    );
    assert.equal(
      await prisma.contract.count({ where: { documentId: purchaseContract.id } }),
      0,
      'a pending contract must not create operational contract data',
    );
    await request(baseUrl, `/documents/${purchaseContract.id}/approve`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
    });
    const vehicleAfterContract = await prisma.vehicle.findUnique({
      where: { id: extractedVehicle!.id },
      include: { seller: true },
    });
    assert.equal(Number(vehicleAfterContract?.purchasePrice), 50_000);
    assert.equal(vehicleAfterContract?.seller?.kind, 'INDIVIDUAL');
    assert.equal(vehicleAfterContract?.seller?.taxId, sellerCnp);
    assert.equal(
      await prisma.party.count({ where: { tenantId: tenant.id, taxId: sellerCnp } }),
      1,
    );

    const vehicleWithReusedSeller = await request(baseUrl, '/vehicles', {
      method: 'POST',
      token: tokens.get('SALES'),
      expected: 201,
      body: {
        vin: 'WBAZZZ1JZXW000002',
        make: 'BMW',
        model: 'Seller reuse',
        year: 2022,
        purchasePrice: 12_000,
        purchaseCurrency: 'EUR',
        seller: {
          kind: 'INDIVIDUAL',
          name: 'Ion Vânzător Acceptance',
          taxId: sellerCnp,
          country: 'RO',
        },
      },
    });
    assert.equal(vehicleWithReusedSeller.seller.id, vehicleAfterContract?.sellerId);
    assert.equal(
      await prisma.party.count({ where: { tenantId: tenant.id, taxId: sellerCnp } }),
      1,
    );

    const privateContractPrefill = await request(
      baseUrl,
      `/etransport/prefill/${extractedVehicle!.id}`,
      { token: tokens.get('ACCOUNTANT'), expected: 200 },
    );
    assert.equal(privateContractPrefill.sourceDocumentId, purchaseContract.id);
    assert.equal(privateContractPrefill.goods[0].valueWithoutVat, 50_000);
    assert.equal(privateContractPrefill.goods[0].currency, 'RON');
    assert.equal(
      privateContractPrefill.fieldSources.value,
      'contract privat de achiziție',
    );

    const sourceKey = `tenants/${tenant.id}/acceptance/source.pdf`;
    await s3.putObject(
      sourceKey,
      Buffer.from('%PDF-1.4\n% AutoImport acceptance fixture\n'),
      'application/pdf',
    );
    const searchableDocument = await prisma.document.create({
      data: {
        tenantId: tenant.id,
        vehicleId: vehicle.id,
        partyId: party.id,
        name: 'UI Acceptance Invoice.pdf',
        type: 'Invoice',
        s3Key: sourceKey,
        contentType: 'application/pdf',
        fileSize: 41,
        documentHash: `${marker}-searchable`,
        processingStatus: 'COMPLETED',
        reviewStatus: 'PENDING_APPROVAL',
        needsReview: true,
        processedData: {
          create: {
            documentType: 'Invoice',
            extractedFields: accountingFields(
              tenant.name,
              tenant.cui!,
              'ACC-SEARCH',
            ),
          },
        },
      },
    });
    const searchResult = await request(
      baseUrl,
      '/documents?search=Acceptance%20Invoice',
      { token: tokens.get('VIEWER'), expected: 200 },
    );
    assert.equal(searchResult.documents[0].id, searchableDocument.id);

    const download = await request(
      baseUrl,
      `/documents/${searchableDocument.id}/download`,
      { token: tokens.get('VIEWER'), expected: 200 },
    );
    assert.match(download.url, /^https?:\/\//);
    await request(baseUrl, `/documents/${searchableDocument.id}/archive`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
    });
    const archived = await request(baseUrl, '/documents?archived=true', {
      token: tokens.get('VIEWER'),
      expected: 200,
    });
    assert.ok(
      archived.documents.some(
        (document: any) => document.id === searchableDocument.id,
      ),
    );
    await request(baseUrl, `/documents/${searchableDocument.id}/unarchive`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
    });

    const form = new FormData();
    form.append(
      'files',
      new Blob(['%PDF-1.4\nacceptance upload'], {
        type: 'application/pdf',
      }),
      'acceptance-upload.pdf',
    );
    const uploadResponse = await fetch(`${baseUrl}/documents/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.get('SALES')}` },
      body: form,
    });
    assert.equal(uploadResponse.status, 201);
    const uploadBody = (await uploadResponse.json()) as any[];
    assert.equal(uploadBody.length, 1);
    await request(
      baseUrl,
      `/documents/pending/${uploadBody[0].pendingUploadId}/cancel`,
      {
        method: 'POST',
        token: tokens.get('SALES'),
        expected: 201,
      },
    );

    const forbiddenDocument = await createApprovalDocument(
      prisma,
      tenant.id,
      tenant.name,
      tenant.cui!,
      `${marker}-forbidden`,
    );
    for (const role of ['SALES', 'VIEWER']) {
      await request(baseUrl, `/documents/${forbiddenDocument.id}/approve`, {
        method: 'POST',
        token: tokens.get(role),
        expected: 403,
      });
    }
    await request(
      baseUrl,
      `/documents/${forbiddenDocument.id}/posting-preview`,
      {
        token: tokens.get('ACCOUNTANT'),
        expected: 200,
      },
    );
    await request(baseUrl, `/documents/${forbiddenDocument.id}/approve`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
    });
    await request(baseUrl, `/documents/${forbiddenDocument.id}/reopen`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
    });
    await request(baseUrl, `/documents/${forbiddenDocument.id}/approve`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
    });
    await request(baseUrl, `/documents/${forbiddenDocument.id}`, {
      token: otherLogin.accessToken,
      expected: 404,
    });

    const generated = await request(baseUrl, '/contracts/generate', {
      method: 'POST',
      token: tokens.get('SALES'),
      expected: 201,
      body: {
        vehicleId: vehicle.id,
        buyerId: party.id,
        kind: 'vanzare-cumparare',
        price: 16500,
        currency: 'EUR',
      },
    });
    assert.ok(generated.documentId);
    const contracts = await request(
      baseUrl,
      `/contracts?vehicleId=${vehicle.id}`,
      { token: tokens.get('VIEWER'), expected: 200 },
    );
    assert.equal(contracts.length, 1);

    const declaration = await request(baseUrl, '/etransport', {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 201,
      body: {
        vehicleId: vehicle.id,
        operationType: 'AIC',
        transportDate: new Date().toISOString().slice(0, 10),
        dataVerified: true,
        transporter: {
          name: 'Transport Acceptance SRL',
          taxId: 'DE12345',
          country: 'DE',
        },
        vehiclePlate: 'B123ACC',
        loadingPlace: { country: 'DE', city: 'Berlin' },
        unloadingPlace: { country: 'RO', county: 'B', city: 'București' },
        goods: [
          {
            description: 'Autoturism test',
            tariffCode: '87032390',
            weightKg: 1327,
            valueWithoutVat: 60000,
            currency: 'RON',
          },
        ],
      },
    });
    assert.match(declaration.xmlPayload, /<eTransport/);
    await request(baseUrl, `/etransport/${declaration.id}/submit`, {
      method: 'POST',
      token: tokens.get('ACCOUNTANT'),
      expected: 400,
    });

    console.log(
      'HTTP acceptance passed: auth roles, tenancy, vehicles, documents, archive/download, contracts, e-Transport and SAGA preferences.',
    );
  } finally {
    await cleanupTenant(prisma, tenant.id, s3);
    await cleanupTenant(prisma, otherTenant.id, s3);
    await app.close();
  }
}

async function createApprovalDocument(
  prisma: PrismaService,
  tenantId: number,
  companyName: string,
  companyCui: string,
  marker: string,
) {
  return prisma.document.create({
    data: {
      tenantId,
      name: `${marker}.pdf`,
      type: 'Invoice',
      s3Key: `test/${marker}.pdf`,
      contentType: 'application/pdf',
      fileSize: 1,
      documentHash: marker,
      processingStatus: 'COMPLETED',
      reviewStatus: 'PENDING_APPROVAL',
      needsReview: true,
      processedData: {
        create: {
          documentType: 'Invoice',
          extractedFields: accountingFields(
            companyName,
            companyCui,
            marker,
          ),
        },
      },
    },
  });
}

async function request(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    expected: number;
  },
): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token
        ? { authorization: `Bearer ${options.token}` }
        : {}),
      ...(options.body !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
    },
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  assert.equal(
    response.status,
    options.expected,
    `${options.method ?? 'GET'} ${path}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
