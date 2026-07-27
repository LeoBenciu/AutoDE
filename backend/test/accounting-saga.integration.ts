import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PostingService } from '../src/accounting/posting.service';
import { AuditService } from '../src/common/audit.service';
import { PrismaService } from '../src/common/prisma.service';
import { SagaService } from '../src/saga/saga.service';

const prisma = new PrismaService();

async function main() {
  await prisma.$connect();
  const marker = `integration-${Date.now()}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: marker,
      cui: '50675950',
      accountingCutoverAt: new Date('2025-01-01T00:00:00.000Z'),
      isVatPayer: true,
    },
  });
  const otherTenant = await prisma.tenant.create({
    data: { name: `${marker}-other`, cui: '123' },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      name: 'Integration Owner',
      email: `${marker}@example.test`,
      passwordHash: 'not-used-by-integration-test',
      role: 'OWNER',
    },
  });
  const posting = new PostingService(prisma);
  const saga = new SagaService(prisma, new AuditService(prisma));
  const today = new Date().toISOString().slice(0, 10);

  const createDocument = async (
    type: string,
    number: string,
    fields: Record<string, unknown>,
    reviewStatus: 'PENDING_APPROVAL' | 'LEGACY' = 'PENDING_APPROVAL',
  ) =>
    prisma.document.create({
      data: {
        tenantId: tenant.id,
        name: `${number}.pdf`,
        type,
        s3Key: `test/${marker}/${number}.pdf`,
        contentType: 'application/pdf',
        fileSize: 1,
        documentHash: `${marker}-${number}`,
        processingStatus: 'COMPLETED',
        reviewStatus,
        needsReview: reviewStatus !== 'LEGACY',
        uploadedAt: new Date(),
        processedData: {
          create: {
            documentType: type,
            extractedFields: {
              document_type: type,
              document_number: number,
              document_date: today,
              currency: 'RON',
              ...fields,
            },
          },
        },
      },
    });

  try {
    const incoming = await createDocument('Invoice', 'IN-1', {
      vendor: 'Furnizor Test SRL',
      vendor_ein: 'RO999001',
      buyer: marker,
      buyer_ein: 'RO50675950',
      total_amount: 119,
      net_amount: 100,
      vat_amount: 19,
      line_items: [
        {
          name: 'Servicii',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 19,
          vat: 'NINETEEN',
          account_code: '628',
          articleCode: 'SERV',
          um: 'UNITATE_DE_SERVICE',
          vat_deductibility: 'FULL',
        },
      ],
    });
    const incomingPreview = await posting.preview(tenant.id, incoming.id);
    assert.deepEqual(incomingPreview.errors, []);
    assert.equal(incomingPreview.totalDebit, 119);
    assert.equal(incomingPreview.totalCredit, 119);
    assert.ok(incomingPreview.entries.some((entry) => entry.accountCode === '4426'));
    assert.ok(incomingPreview.entries.some((entry) => entry.accountCode === '401'));

    await posting.approve(tenant.id, user.id, incoming.id);
    await posting.approve(tenant.id, user.id, incoming.id);
    assert.equal(
      await prisma.generalLedgerEntry.count({ where: { documentId: incoming.id } }),
      incomingPreview.entries.length,
      'idempotent approval must not duplicate ledger entries',
    );
    assert.equal(
      await prisma.auditLog.count({
        where: {
          tenantId: tenant.id,
          entityId: incoming.id,
          action: 'document.approved_and_posted',
        },
      }),
      1,
      'idempotent approval must create one approval audit event',
    );

    const outgoing = await createDocument('Invoice', 'OUT-1', {
      vendor: marker,
      vendor_ein: '50675950',
      buyer: 'Client Test SRL',
      buyer_ein: 'RO888002',
      total_amount: 121,
      net_amount: 100,
      vat_amount: 21,
      line_items: [
        {
          name: 'Autoturism',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 21,
          vat: 'TWENTYONE',
          account_code: '707',
          articleCode: 'AUTO',
          um: 'BUCATA',
        },
      ],
    });
    const outgoingApproved = await posting.approve(tenant.id, user.id, outgoing.id);
    assert.ok(outgoingApproved.posting.entries.some((entry) => entry.accountCode.startsWith('411')));
    assert.ok(outgoingApproved.posting.entries.some((entry) => entry.accountCode === '4427'));

    const independentIncoming = await createDocument('Receipt', 'BON-IN', {
      vendor: 'Benzinărie SRL',
      vendor_ein: 'RO777003',
      buyer: marker,
      buyer_ein: '50675950',
      receipt_type: 'independent_receipt',
      payment_method: 'cash',
      total_amount: 119,
      net_amount: 100,
      vat_amount: 19,
      line_items: [
        {
          name: 'Combustibil',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 19,
          vat: 'NINETEEN',
          account_code: '6022',
          articleCode: 'FUEL',
          um: 'LITRU',
          vat_deductibility: 'PARTIAL_50',
        },
      ],
    });
    const independentIncomingApproved = await posting.approve(
      tenant.id,
      user.id,
      independentIncoming.id,
    );
    assert.ok(
      independentIncomingApproved.posting.entries.some(
        (entry) => entry.accountCode === '5311' && entry.credit === 119,
      ),
    );
    assert.ok(
      independentIncomingApproved.posting.entries.some(
        (entry) => entry.accountCode === '4426' && entry.debit === 9.5,
      ),
    );
    assert.ok(
      independentIncomingApproved.posting.entries.some(
        (entry) => entry.accountCode === '6022' && entry.debit === 109.5,
      ),
    );

    const independentOutgoing = await createDocument('Receipt', 'BON-OUT', {
      vendor: marker,
      vendor_ein: '50675950',
      buyer: 'Client Bon SRL',
      buyer_ein: 'RO666004',
      receipt_type: 'independent_receipt',
      payment_method: 'cash',
      total_amount: 121,
      net_amount: 100,
      vat_amount: 21,
      line_items: [
        {
          name: 'Marfă',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 21,
          vat: 'TWENTYONE',
          account_code: '707',
          articleCode: 'MARFA',
          um: 'BUCATA',
        },
      ],
    });
    const independentOutgoingApproved = await posting.approve(
      tenant.id,
      user.id,
      independentOutgoing.id,
    );
    assert.ok(
      independentOutgoingApproved.posting.entries.some(
        (entry) => entry.accountCode === '5311' && entry.debit === 121,
      ),
    );

    const incomingSecond = await createDocument('Invoice', 'IN-2', {
      vendor: 'Furnizor Test SRL',
      vendor_ein: 'RO999001',
      buyer: marker,
      buyer_ein: 'RO50675950',
      total_amount: 10,
      net_amount: 10,
      vat_amount: 0,
      line_items: [
        {
          name: 'Serviciu secundar',
          quantity: 1,
          unit_price: 10,
          total: 10,
          vat_amount: 0,
          account_code: '628',
          articleCode: 'SERV-2',
        },
      ],
    });
    await posting.approve(tenant.id, user.id, incomingSecond.id);

    const invoicePayment = await createDocument('Receipt', 'CH-1', {
      vendor: 'Furnizor Test SRL',
      vendor_ein: 'RO999001',
      buyer: marker,
      buyer_ein: '50675950',
      receipt_type: 'payment_receipt',
      payment_method: 'cash',
      referenced_invoices: [
        { number: 'IN-1', amount: 30 },
        { number: 'IN-2', amount: 20 },
      ],
      total_amount: 50,
      net_amount: 50,
      vat_amount: 0,
      line_items: [],
    });
    const paymentApproved = await posting.approve(
      tenant.id,
      user.id,
      invoicePayment.id,
    );
    assert.equal(paymentApproved.posting.sourceType, 'RECEIPT_IN');
    assert.ok(
      paymentApproved.posting.entries.some(
        (entry) => entry.accountCode.startsWith('401') && entry.debit === 50,
      ),
    );
    assert.equal(
      await prisma.documentRelationship.count({
        where: { parentId: incoming.id, childId: invoicePayment.id, relation: 'payment' },
      }),
      1,
    );
    const paymentLinks = await prisma.documentRelationship.findMany({
      where: { childId: invoicePayment.id, relation: 'payment' },
      orderBy: { parentId: 'asc' },
    });
    assert.deepEqual(
      paymentLinks.map((link) => Number(link.paymentAmount)).sort((a, b) => a - b),
      [20, 30],
    );

    const paymentDisposition = await createDocument(
      'Payment Disposition',
      'DP-1',
      {
        total_amount: 75,
        net_amount: 75,
        account_code: '628',
        description: 'Avans transport',
      },
    );
    const paymentDispositionApproved = await posting.approve(
      tenant.id,
      user.id,
      paymentDisposition.id,
    );
    assert.equal(paymentDispositionApproved.posting.sourceType, 'PAYMENT_DISPOSITION');
    assert.ok(
      paymentDispositionApproved.posting.entries.some(
        (entry) => entry.accountCode === '5311' && entry.credit === 75,
      ),
    );

    const collectionDisposition = await createDocument(
      'Collection Disposition',
      'DI-1',
      {
        total_amount: 80,
        net_amount: 80,
        account_code: '707',
        description: 'Încasare avans',
      },
    );
    const collectionDispositionApproved = await posting.approve(
      tenant.id,
      user.id,
      collectionDisposition.id,
    );
    assert.equal(
      collectionDispositionApproved.posting.sourceType,
      'COLLECTION_DISPOSITION',
    );
    assert.ok(
      collectionDispositionApproved.posting.entries.some(
        (entry) => entry.accountCode === '5311' && entry.debit === 80,
      ),
    );

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { isVatPayer: false },
    });
    const nonVat = await createDocument('Invoice', 'NON-VAT', {
      vendor: 'Neplatitor Test',
      vendor_ein: 'RO555005',
      buyer: marker,
      buyer_ein: '50675950',
      total_amount: 119,
      net_amount: 100,
      vat_amount: 19,
      line_items: [
        {
          name: 'Cost brut',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 19,
          account_code: '628',
          articleCode: 'BRUT',
        },
      ],
    });
    const nonVatPreview = await posting.preview(tenant.id, nonVat.id);
    assert.ok(!nonVatPreview.entries.some((entry) => entry.accountCode === '4426'));
    assert.ok(
      nonVatPreview.entries.some(
        (entry) => entry.accountCode === '628' && entry.debit === 119,
      ),
    );
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { isVatPayer: true },
    });

    const reverseCharge = await createDocument('Invoice', 'REV-1', {
      vendor: 'EU Supplier',
      vendor_ein: 'DE12345',
      vendor_country: 'DE',
      buyer: marker,
      buyer_ein: '50675950',
      reverse_charge: true,
      total_amount: 100,
      net_amount: 100,
      vat_amount: 0,
      line_items: [
        {
          name: 'Serviciu UE',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 0,
          vat: 'TWENTYONE',
          account_code: '628',
          articleCode: 'EU-SERV',
        },
      ],
    });
    const reversePreview = await posting.preview(tenant.id, reverseCharge.id);
    assert.ok(
      reversePreview.entries.some(
        (entry) => entry.accountCode === '4426' && entry.debit === 21,
      ),
    );
    assert.ok(
      reversePreview.entries.some(
        (entry) => entry.accountCode === '4427' && entry.credit === 21,
      ),
    );

    const foreign = await createDocument('Invoice', 'EUR-1', {
      vendor: 'EU Supplier 2',
      vendor_ein: 'DE54321',
      vendor_country: 'DE',
      buyer: marker,
      buyer_ein: '50675950',
      currency: 'EUR',
      exchange_rate: 5,
      total_amount: 100,
      net_amount: 100,
      vat_amount: 0,
      line_items: [
        {
          name: 'Transport UE',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 0,
          account_code: '624',
          articleCode: 'TRANS-EU',
        },
      ],
    });
    const foreignPreview = await posting.preview(tenant.id, foreign.id);
    assert.equal(foreignPreview.totalDebit, 500);
    assert.equal(foreignPreview.totalCredit, 500);
    assert.equal(foreignPreview.exchangeRate, 5);

    const foreignBankReceipt = await createDocument('Receipt', 'EUR-BON', {
      vendor: 'EU Shop',
      vendor_ein: 'DE99999',
      vendor_country: 'DE',
      buyer: marker,
      buyer_ein: '50675950',
      currency: 'EUR',
      exchange_rate: 5,
      receipt_type: 'independent_receipt',
      payment_method: 'bank',
      total_amount: 10,
      net_amount: 10,
      vat_amount: 0,
      line_items: [
        {
          name: 'Cost valută',
          quantity: 1,
          unit_price: 10,
          total: 10,
          vat_amount: 0,
          account_code: '628',
          articleCode: 'FX-COST',
        },
      ],
    });
    const foreignReceiptApproved = await posting.approve(
      tenant.id,
      user.id,
      foreignBankReceipt.id,
    );
    assert.ok(
      foreignReceiptApproved.posting.entries.some(
        (entry) => entry.accountCode === '5124' && entry.credit === 50,
      ),
    );

    const advance = await createDocument('Invoice', 'ADV-1', {
      vendor: marker,
      vendor_ein: '50675950',
      buyer: 'Client Avans',
      buyer_ein: 'RO444004',
      is_advance: true,
      total_amount: 121,
      net_amount: 100,
      vat_amount: 21,
      line_items: [
        {
          name: 'Avans autoturism',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 21,
          vat: 'TWENTYONE',
          account_code: '707',
          articleCode: 'ADV',
        },
      ],
    });
    const advanceApproved = await posting.approve(tenant.id, user.id, advance.id);
    assert.ok(
      advanceApproved.posting.entries.some(
        (entry) => entry.accountCode === '419' && entry.credit === 100,
      ),
    );

    const rounding = await createDocument('Invoice', 'ROUND-1', {
      vendor: 'Furnizor Rotunjire',
      vendor_ein: 'RO333003',
      buyer: marker,
      buyer_ein: '50675950',
      total_amount: 118.99,
      net_amount: 99.99,
      vat_amount: 19,
      line_items: [
        {
          name: 'Linia 1',
          quantity: 1,
          unit_price: 33.33,
          total: 33.33,
          vat_amount: 6.33,
          vat: 'NINETEEN',
          account_code: '628',
          articleCode: 'ROUND-1',
        },
        {
          name: 'Linia 2',
          quantity: 1,
          unit_price: 33.33,
          total: 33.33,
          vat_amount: 6.33,
          vat: 'NINETEEN',
          account_code: '628',
          articleCode: 'ROUND-2',
        },
        {
          name: 'Linia 3',
          quantity: 1,
          unit_price: 33.33,
          total: 33.33,
          vat_amount: 6.34,
          vat: 'NINETEEN',
          account_code: '628',
          articleCode: 'ROUND-3',
        },
      ],
    });
    const roundingApproved = await posting.approve(
      tenant.id,
      user.id,
      rounding.id,
    );
    assert.equal(roundingApproved.posting.totalDebit, 118.99);
    assert.equal(roundingApproved.posting.totalCredit, 118.99);

    const vehiclePurchaseInvoice = await createDocument(
      'Invoice',
      'AUTO-IN-1',
      {
        direction: 'incoming',
        vendor: 'Dealer Auto GmbH',
        vendor_ein: 'DE99887766',
        vendor_country: 'DE',
        buyer: marker,
        buyer_ein: '50675950',
        vehicle_transaction: 'purchase',
        vin: 'WBAZZZ3CZEJ000002',
        vehicle_make: 'BMW',
        vehicle_model: 'X3',
        vehicle_year: 2020,
        total_amount: 11_900,
        net_amount: 10_000,
        vat_amount: 1_900,
        line_items: [
          {
            name: 'Autoturism BMW X3 VIN WBAZZZ3CZEJ000002',
            quantity: 1,
            unit_price: 10_000,
            total: 10_000,
            vat_amount: 1_900,
            vat: 'NINETEEN',
            account_code: '371',
            articleCode: 'AUTO-EJ000002',
            um: 'BUCATA',
            vat_deductibility: 'FULL',
          },
        ],
      },
    );
    await posting.approve(tenant.id, user.id, vehiclePurchaseInvoice.id);
    const invoicedVehicle = await prisma.vehicle.findUnique({
      where: {
        tenantId_vin: {
          tenantId: tenant.id,
          vin: 'WBAZZZ3CZEJ000002',
        },
      },
    });
    assert.equal(invoicedVehicle?.status, 'PURCHASED');
    assert.equal(Number(invoicedVehicle?.purchasePrice), 10_000);
    assert.equal(invoicedVehicle?.make, 'BMW');
    assert.equal(invoicedVehicle?.model, 'X3');

    const purchaseContract = await createDocument('Contract', 'CA-1', {
      direction: 'incoming',
      contract_number: 'CA-1',
      contract_type: 'vanzare-cumparare autoturism',
      contract_date: today,
      total_value: 50_000,
      vehicle_transaction: 'purchase',
      vin: 'WVWZZZ1JZXW000001',
      vehicle_make: 'Volkswagen',
      vehicle_model: 'Golf',
      vehicle_year: 2021,
      parties: [
        {
          name: 'Ion Vânzător',
          ein: '1800101223344',
          role: 'vendor',
          kind: 'INDIVIDUAL',
          country: 'RO',
        },
        {
          name: marker,
          ein: '50675950',
          role: 'client',
          kind: 'COMPANY',
          country: 'RO',
        },
      ],
    });
    const contractApproved = await posting.approve(
      tenant.id,
      user.id,
      purchaseContract.id,
    );
    assert.equal(contractApproved.posting.sourceType, 'CONTRACT_PURCHASE');
    assert.ok(
      contractApproved.posting.entries.some(
        (entry) => entry.accountCode === '371' && entry.debit === 50_000,
      ),
    );
    assert.ok(
      contractApproved.posting.entries.some(
        (entry) => entry.accountCode === '462' && entry.credit === 50_000,
      ),
    );
    const purchasedVehicle = await prisma.vehicle.findUnique({
      where: {
        tenantId_vin: {
          tenantId: tenant.id,
          vin: 'WVWZZZ1JZXW000001',
        },
      },
      include: { seller: true },
    });
    assert.equal(purchasedVehicle?.status, 'PURCHASED');
    assert.equal(Number(purchasedVehicle?.purchasePrice), 50_000);
    assert.equal(purchasedVehicle?.seller?.kind, 'INDIVIDUAL');
    assert.equal(purchasedVehicle?.seller?.name, 'Ion Vânzător');

    const refurbishment = await createDocument('Invoice', 'REFURB-1', {
      direction: 'incoming',
      vendor: 'Service Auto SRL',
      vendor_ein: 'RO1234567',
      buyer: marker,
      buyer_ein: '50675950',
      vehicle_transaction: 'cost',
      vehicle_cost_category: 'REFURB',
      vin: 'WVWZZZ1JZXW000001',
      currency: 'EUR',
      exchange_rate: 5,
      total_amount: 121,
      net_amount: 100,
      vat_amount: 21,
      line_items: [
        {
          name: 'Recondiționare autoturism',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 21,
          vat: 'TWENTYONE',
          account_code: '611',
          articleCode: 'REFURB-TEST',
          um: 'UNITATE_DE_SERVICE',
          vat_deductibility: 'FULL',
          vehicle_cost_category: 'REFURB',
        },
      ],
    });
    await prisma.document.update({
      where: { id: refurbishment.id },
      data: { vehicleId: purchasedVehicle!.id },
    });
    await posting.approve(tenant.id, user.id, refurbishment.id);
    const documentCosts = await prisma.vehicleCost.findMany({
      where: { documentId: refurbishment.id, autoGenerated: true },
    });
    assert.equal(documentCosts.length, 1);
    assert.equal(documentCosts[0].category, 'REFURB');
    assert.equal(Number(documentCosts[0].amount), 500);
    assert.equal(documentCosts[0].currency, 'RON');
    const vehicleWithCost = await prisma.vehicle.findUnique({
      where: { id: purchasedVehicle!.id },
    });
    assert.equal(Number(vehicleWithCost?.landedCost), 50_500);

    const invalid = await createDocument('Invoice', 'INVALID-1', {
      vendor: 'Furnizor',
      vendor_ein: 'RO111',
      buyer: marker,
      buyer_ein: '50675950',
      total_amount: 119,
      net_amount: 100,
      vat_amount: 19,
      line_items: [
        {
          name: 'Linie eronată',
          quantity: 1,
          unit_price: 90,
          total: 90,
          vat_amount: 19,
          account_code: '628',
        },
      ],
    });
    const invalidPreview = await posting.preview(tenant.id, invalid.id);
    assert.ok(invalidPreview.errors.some((error) => error.includes('Liniile însumează')));
    await assert.rejects(() => posting.approve(tenant.id, user.id, invalid.id));

    const legacy = await createDocument(
      'Invoice',
      'LEGACY-1',
      {
        vendor: 'Istoric',
        vendor_ein: 'RO222',
        buyer: marker,
        buyer_ein: '50675950',
        total_amount: 1,
        net_amount: 1,
        line_items: [{ name: 'Istoric', total: 1, account_code: '628' }],
      },
      'LEGACY',
    );
    await assert.rejects(() => posting.approve(tenant.id, user.id, legacy.id));
    await assert.rejects(() => posting.preview(otherTenant.id, incoming.id));

    const sagaPreview = await saga.preview(tenant.id, {
      from: today,
      to: today,
      types: ['facturi', 'incasari', 'plati', 'furnizori', 'clienti', 'articole'],
    });
    assert.equal(sagaPreview.counts.incasari, 2);
    assert.equal(sagaPreview.counts.plati, 5);
    assert.ok(sagaPreview.counts.facturi >= 4);
    assert.ok(sagaPreview.counts.furnizori > 0);
    assert.ok(sagaPreview.counts.clienti > 0);
    assert.ok(sagaPreview.counts.articole > 0);

    const archive = await saga.exportZip(tenant.id, user.id, {
      from: today,
      to: today,
    });
    assert.equal(archive.fileCount, 6);
    const zip = await JSZip.loadAsync(archive.content);
    const fileNames = Object.keys(zip.files);
    assert.equal(fileNames.length, 6);
    const facturiName = fileNames.find((name) => name.startsWith('F_'))!;
    const facturiXml = await zip.file(facturiName)!.async('string');
    const incasariXml = await zip.file(fileNames.find((name) => name.startsWith('I_'))!)!.async('string');
    const platiXml = await zip.file(fileNames.find((name) => name.startsWith('P_'))!)!.async('string');
    const suppliersXml = await zip.file(fileNames.find((name) => name.startsWith('FUR_'))!)!.async('string');
    const clientsXml = await zip.file(fileNames.find((name) => name.startsWith('CLI_'))!)!.async('string');
    const articlesXml = await zip.file(fileNames.find((name) => name.startsWith('ART_'))!)!.async('string');
    assert.match(facturiXml, /<Facturi>[\s\S]*<FacturaTip>C<\/FacturaTip>/);
    assert.match(facturiXml, /<FacturaNumar>CA-1<\/FacturaNumar>/);
    assert.match(facturiXml, /<Descriere>Autoturism Volkswagen Golf VIN WVWZZZ1JZXW000001<\/Descriere>/);
    assert.match(facturiXml, /<TipDeducere><\/TipDeducere>/);
    assert.match(incasariXml, /<Incasari>[\s\S]*<Cont>5311<\/Cont>/);
    assert.match(platiXml, /<Plati>[\s\S]*<ContFurnizor>401\./);
    assert.match(platiXml, /<Suma>30<\/Suma>/);
    assert.match(platiXml, /<Suma>20<\/Suma>/);
    assert.match(suppliersXml, /<Furnizori>[\s\S]*<Cod_fiscal>/);
    assert.match(clientsXml, /<Clienti>[\s\S]*<Reg_com>/);
    assert.match(articlesXml, /<Articole>[\s\S]*<UM>/);

    await posting.reopen(tenant.id, user.id, incoming.id);
    assert.equal(
      await prisma.generalLedgerEntry.count({ where: { documentId: incoming.id } }),
      0,
    );
    const reopened = await prisma.document.findUnique({ where: { id: incoming.id } });
    assert.equal(reopened?.reviewStatus, 'REOPENED');

    await posting.reopen(tenant.id, user.id, refurbishment.id);
    assert.equal(
      await prisma.vehicleCost.count({
        where: { documentId: refurbishment.id, autoGenerated: true },
      }),
      0,
    );
    const vehicleAfterCostReopen = await prisma.vehicle.findUnique({
      where: { id: purchasedVehicle!.id },
    });
    assert.equal(Number(vehicleAfterCostReopen?.landedCost), 50_000);

    console.log('Accounting posting and all six SAGA exports passed.');
  } finally {
    await cleanupTenant(tenant.id);
    await cleanupTenant(otherTenant.id);
    await prisma.$disconnect();
  }
}

async function cleanupTenant(tenantId: number) {
  const documents = await prisma.document.findMany({
    where: { tenantId },
    select: { id: true },
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
    prisma.contract.deleteMany({ where: { tenantId } }),
    prisma.vehicleCost.deleteMany({ where: { vehicleId: { in: vehicleIds } } }),
    prisma.userCorrection.deleteMany({ where: { tenantId } }),
    prisma.processedData.deleteMany({ where: { documentId: { in: documentIds } } }),
    prisma.document.deleteMany({ where: { tenantId } }),
    prisma.vehicle.deleteMany({ where: { tenantId } }),
    prisma.article.deleteMany({ where: { tenantId } }),
    prisma.management.deleteMany({ where: { tenantId } }),
    prisma.party.deleteMany({ where: { tenantId } }),
    prisma.user.deleteMany({ where: { tenantId } }),
  ]);
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
