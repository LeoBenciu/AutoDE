import assert from 'node:assert/strict';
import { PartiesService, UploadedCsv } from '../src/parties/parties.service';

interface FakeParty {
  id: number;
  tenantId: number;
  kind: 'INDIVIDUAL' | 'COMPANY';
  identifierType: 'CUI' | 'CNP' | 'FOREIGN_ID' | null;
  name: string;
  taxId: string | null;
  isSupplier: boolean;
  isClient: boolean;
  supplierCode: string | null;
  clientCode: string | null;
  supplierAnalytic: string | null;
  clientAnalytic: string | null;
  registration: string | null;
  country: string;
  county: string | null;
  city: string | null;
  address: string | null;
  iban: string | null;
  bankName: string | null;
  email: string | null;
  phone: string | null;
  discount: string | null;
}

async function main() {
  const tenantId = 9;
  const parties: FakeParty[] = [
    fakeParty({
      id: 1,
      tenantId,
      name: 'Andrei-Mihai Popescu',
      supplierCode: '00004',
      isSupplier: true,
    }),
    fakeParty({
      id: 2,
      tenantId,
      name: 'AUTO1 European Cars B.V.',
      supplierCode: '00002',
      country: 'NL',
      isSupplier: true,
    }),
    fakeParty({
      id: 3,
      tenantId,
      name: 'Client existent SRL',
      clientCode: '00001',
      taxId: '99999999',
      identifierType: 'CUI',
      isClient: true,
    }),
  ];
  let nextId = 4;
  let createCalls = 0;

  const prisma: any = {
    party: {
      findMany: async ({ where }: any) =>
        parties.filter((party) => party.tenantId === where.tenantId),
      update: async ({ where, data }: any) => {
        const party = parties.find((candidate) => candidate.id === where.id);
        assert.ok(party, `missing fake party ${where.id}`);
        Object.assign(party, data);
        return party;
      },
      create: async ({ data }: any) => {
        createCalls += 1;
        const party = { ...data, id: nextId++ } as FakeParty;
        parties.push(party);
        return party;
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
  };
  const service = new PartiesService(prisma);

  const csv = uploaded(
    'furnizori.csv',
    'text/csv',
    [
      'Cod Furnizor;Denumire;CUI/CNP;Tara;Cont_banca',
      '00004;Andrei-Mihai Popescu;5050217041556;RO;RO49AAAA1B31007593840000',
    ].join('\n'),
  );
  const first = await service.import(tenantId, 'supplier', csv);
  assert.deepEqual(
    {
      created: first.created,
      updated: first.updated,
      identifiersFilled: first.identifiersFilled,
      errors: first.errors,
    },
    { created: 0, updated: 1, identifiersFilled: 1, errors: [] },
  );
  assert.equal(parties.length, 3);
  assert.equal(parties[0].taxId, '5050217041556');
  assert.equal(parties[0].kind, 'INDIVIDUAL');
  assert.equal(parties[0].identifierType, 'CNP');
  assert.equal(parties[0].iban, 'RO49AAAA1B31007593840000');

  const repeated = await service.import(tenantId, 'supplier', csv);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.updated, 1);
  assert.equal(repeated.identifiersFilled, 0);
  assert.equal(parties.length, 3);

  const xml = uploaded(
    'FUR.xml',
    'application/xml',
    `<?xml version="1.0" encoding="UTF-8"?>
      <Furnizori><Linie>
        <Cod>00002</Cod>
        <Denumire>AUTO1 European Cars B.V.</Denumire>
        <Cod_fiscal>NL856915361B01</Cod_fiscal>
        <Tara>NL</Tara>
        <Adresa>Strada &amp; Numărul 1</Adresa>
      </Linie></Furnizori>`,
  );
  const xmlResult = await service.import(tenantId, 'supplier', xml);
  assert.equal(xmlResult.created, 0);
  assert.equal(xmlResult.identifiersFilled, 1);
  assert.equal(parties[1].taxId, 'NL856915361B01');
  assert.equal(parties[1].address, 'Strada & Numărul 1');
  assert.equal(parties[1].identifierType, 'CUI');

  const conflict = uploaded(
    'clienti.csv',
    'text/csv',
    'Cod Client,Denumire,Număr identificare\n00001,Client existent SRL,12345678',
  );
  const conflictResult = await service.import(tenantId, 'client', conflict);
  assert.equal(conflictResult.created, 0);
  assert.equal(conflictResult.updated, 0);
  assert.equal(conflictResult.errors.length, 1);
  assert.match(conflictResult.errors[0], /are deja numărul de identificare/);
  assert.equal(parties[2].taxId, '99999999');

  const duplicatedRows = uploaded(
    'clienti-noi.csv',
    'text/csv',
    [
      'Cod;Denumire;Cod_fiscal',
      '00077;Companie Nouă SRL;RO11201891',
      '00077;Companie Nouă SRL;RO11201891',
    ].join('\n'),
  );
  const duplicateResult = await service.import(
    tenantId,
    'client',
    duplicatedRows,
  );
  assert.equal(duplicateResult.created, 1);
  assert.equal(duplicateResult.updated, 1);
  assert.equal(createCalls, 1);
  assert.equal(
    parties.filter((party) => party.taxId === '11201891').length,
    1,
  );

  console.log('parties-import.spec.ts passed');
}

function uploaded(
  originalname: string,
  mimetype: string,
  contents: string,
): UploadedCsv {
  return { originalname, mimetype, buffer: Buffer.from(contents, 'utf8') };
}

function fakeParty(overrides: Partial<FakeParty>): FakeParty {
  return {
    id: 0,
    tenantId: 0,
    kind: 'COMPANY',
    identifierType: null,
    name: '',
    taxId: null,
    isSupplier: false,
    isClient: false,
    supplierCode: null,
    clientCode: null,
    supplierAnalytic: null,
    clientAnalytic: null,
    registration: null,
    country: 'RO',
    county: null,
    city: null,
    address: null,
    iban: null,
    bankName: null,
    email: null,
    phone: null,
    discount: null,
    ...overrides,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
