import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import JSZip = require('jszip');
import {
  parseAnafStatusResponse,
  parseAnafUploadIndex,
} from '../src/etransport/anaf-client';
import { parseBnrRateXml } from '../src/etransport/bnr-rate';
import {
  DriveVehicleDataService,
  parseVehicleWeightKg,
  parseVehicleWorkbook,
} from '../src/etransport/drive-vehicle-data.service';
import {
  EtransportService,
  selectUitPurchaseSource,
  validityDaysForOperation,
} from '../src/etransport/etransport.service';
import {
  buildETransportXml,
  buildETransportInfirmationXml,
  DeclarationData,
  defaultScopeCode,
  normalizeScopeCode,
} from '../src/etransport/xml-builder';
import { eTransportCodJudet } from '../src/etransport/judet-codes';

const base: DeclarationData = {
  tenantCui: '12345678',
  operationType: 'AIC',
  transporter: { name: 'Transportator verificat', taxId: 'DE123', country: 'DE' },
  vehiclePlate: 'B123UIT',
  loadingPlace: { country: 'DE', city: 'Berlin' },
  unloadingPlace: { country: 'RO', county: 'B', city: 'București', address: 'Str. Exemplu 1' },
  transportDate: '2026-07-28',
  goods: [
    {
      description: 'Autoturism identificat prin VIN',
      tariffCode: '87032390',
      weightKg: 1327,
      valueRon: 65000.25,
    },
  ],
};

const xml = buildETransportXml(base);
// v2 schema: notificare/bunuriTransportate/partenerComercial/dateTransport
// carry their data as XML attributes, not child elements.
assert.match(xml, /<notificare codTipOperatiune="10"/);
assert.match(xml, /<bunuriTransportate codScopOperatiune="101"/);
assert.doesNotMatch(xml, /codScopOperatiune="100101"/);
assert.match(xml, /codTarifar="87032390"/);
assert.match(xml, /greutateNeta="1327"/);
assert.match(xml, /greutateBruta="1327"/);
assert.match(xml, /valoareLeiFaraTva="65000\.25"/);
assert.match(xml, /<partenerComercial codTara="DE"/);
assert.match(xml, /<dateTransport nrVehicul="B123UIT"/);
// ANAF currently returns a JSON receipt even though older environments used
// an XML-like attribute. Both formats must advance the declaration to SUBMITTED.
const successfulUploadResponse = JSON.stringify({
  dateResponse: '202608101800',
  ExecutionStatus: 0,
  index_incarcare: 5060642348,
  UIT: '5F3P2L8P0T8D1574',
  trace_id: 'b5559b50-6027-4135-8560-c1407545097c',
});
assert.equal(parseAnafUploadIndex(successfulUploadResponse), '5060642348');
assert.equal(parseAnafUploadIndex('<header index_incarcare="5060642349"/>'), '5060642349');
assert.equal(parseAnafUploadIndex('{"ExecutionStatus":1}'), undefined);
assert.deepEqual(
  parseAnafStatusResponse('{"stare":"ok","UIT":"5F3P2L8P0T8D1574"}'),
  { status: 'CONFIRMED', uit: '5F3P2L8P0T8D1574' },
);
assert.deepEqual(parseAnafStatusResponse('{"stare":"nok"}'), { status: 'REJECTED' });
assert.deepEqual(parseAnafStatusResponse('{"stare":"in_prelucru"}'), { status: 'PENDING' });
const infirmationXml = buildETransportInfirmationXml(
  '31194616',
  '5F3P2L8P0T8D1574',
  'Transport anulat & neefectuat',
);
assert.match(infirmationXml, /<eTransport[^>]*codDeclarant="31194616"/);
assert.match(
  infirmationXml,
  /<confirmare uit="5F3P2L8P0T8D1574" tipConfirmare="30" observatii="Transport anulat &amp; neefectuat"\/>/,
);
// ANAF v2 accepts the short scope-code enumeration. Ownership-transfer flows
// use Comercializare (101); non-transfer/customs/warehousing flows use 9999.
for (const operationCode of ['10', '20', '30']) {
  assert.equal(defaultScopeCode(operationCode), '101');
}
for (const operationCode of ['12', '14', '22', '24', '40', '50', '60', '70']) {
  assert.equal(defaultScopeCode(operationCode), '9999');
}
// Drafts saved by the previous release can contain operation-prefixed scope
// overrides. Normalize those too; otherwise the override wins over the fixed
// default and ANAF sees the same invalid 100101 value on retry.
assert.equal(normalizeScopeCode('100101', '10'), '101');
assert.equal(normalizeScopeCode('200101', '20'), '101');
assert.equal(normalizeScopeCode('100703', '12'), '703');
assert.equal(normalizeScopeCode('404001', '40'), '9999');
assert.equal(normalizeScopeCode('201', '10'), '201');
const legacyDraftXml = buildETransportXml({
  ...base,
  goods: [{ ...base.goods[0], scopeCode: '100101' }],
});
assert.match(legacyDraftXml, /codScopOperatiune="101"/);
assert.doesNotMatch(legacyDraftXml, /codScopOperatiune="100101"/);
const explicitNetWeightXml = buildETransportXml({
  ...base,
  goods: [{ ...base.goods[0], netWeightKg: 1300 }],
});
assert.match(explicitNetWeightXml, /greutateNeta="1300"/);
assert.match(explicitNetWeightXml, /greutateBruta="1327"/);
// BR-043: cod/codOrgTransport must be the bare CUI, without the country prefix.
const roOrgXml = buildETransportXml({
  ...base,
  transporter: { name: 'PLAYER MEDIA SRL', taxId: 'RO20752458', country: 'RO' },
});
assert.match(roOrgXml, /codOrgTransport="20752458"/);
assert.doesNotMatch(roOrgXml, /codOrgTransport="RO20752458"/);
assert.match(roOrgXml, /<partenerComercial codTara="RO" cod="20752458"/);
// partenerComercial is the (foreign) seller, distinct from the transporter which
// stays on dateTransport.
const partnerXml = buildETransportXml({
  ...base,
  transporter: { name: 'PLAYER MEDIA SRL', taxId: 'RO20752458', country: 'RO' },
  partner: { name: 'AUTO1 European Cars B.V.', taxId: 'NL861042479B01', country: 'NL' },
});
assert.match(
  partnerXml,
  /<partenerComercial codTara="NL" cod="861042479B01" denumire="AUTO1 European Cars B\.V\."/,
);
assert.match(partnerXml, /<dateTransport[^>]*denumireOrgTransport="PLAYER MEDIA SRL"/);
// The border crossing point is not declared unless explicitly provided.
assert.doesNotMatch(xml, /codPtf=/);
// An intra-community operation carries the border crossing point (codPtf) as an
// attribute of the route-leg element (locStart/locFinalTraseuRutier) — the v2
// schema places it there, NOT on dateTransport (which rejects it: "Attribute
// 'codPtf' is not allowed to appear in element 'dateTransport'").
const borderXml = buildETransportXml({
  ...base,
  loadingPlace: { country: 'DE', city: 'Berlin', borderCrossingPoint: '37' },
});
assert.match(borderXml, /<locStartTraseuRutier codPtf="37">/);
assert.doesNotMatch(borderXml, /<dateTransport[^>]*codPtf/);
// The XSD requires at least one documenteTransport; with none supplied it falls
// back to a CMR (10) dated on the transport day.
assert.match(xml, /<documenteTransport tipDocument="10" dataDocument="2026-07-28"\/>/);
// Supplied documents are emitted with their number and date.
const withDocXml = buildETransportXml({
  ...base,
  documents: [{ tipDocument: '20', dataDocument: '2026-08-01', documentNumber: 'F-123' }],
});
assert.match(
  withDocXml,
  /<documenteTransport tipDocument="20" numarDocument="F-123" dataDocument="2026-08-01"\/>/,
);
// Unloading place is a Romanian locatie whose county is emitted as the numeric
// ANAF codJudet (București "B" → 40), never the 2-letter plate code.
assert.match(xml, /<locFinalTraseuRutier>\s*<locatie codJudet="40"/);
// codJudet + denumireLocalitate are required; the street is emitted when given.
assert.match(xml, /denumireLocalitate="București"/);
assert.match(xml, /denumireStrada="Str\. Exemplu 1"/);

// denumireStrada is required and must be non-empty AND present: with no explicit
// street it falls back to the city so ANAF gets a value (never empty/omitted).
const noStreetXml = buildETransportXml({
  ...base,
  unloadingPlace: { country: 'RO', county: 'B', city: 'București' },
});
assert.match(
  noStreetXml,
  /<locatie codJudet="40" denumireLocalitate="București" denumireStrada="București"\/>/,
);

// A county given as its plate code becomes the numeric codJudet the XSD needs
// (this is what the 'AG' is not a valid value for 'integer' rejection was about).
const argesXml = buildETransportXml({
  ...base,
  unloadingPlace: { country: 'RO', county: 'AG', city: 'Pitești' },
});
assert.match(argesXml, /<locatie codJudet="3"/);
// Full county names resolve too, diacritics or "Județul" prefix notwithstanding.
assert.equal(eTransportCodJudet('Argeș'), '3');
assert.equal(eTransportCodJudet('Județul Cluj'), '12');
assert.equal(eTransportCodJudet('bucuresti'), '40');
// The non-alphabetical tail must not be guessed as 41/42.
assert.equal(eTransportCodJudet('CL'), '51');
assert.equal(eTransportCodJudet('Giurgiu'), '52');
assert.equal(eTransportCodJudet('IF'), '23');
// Already-numeric passes through; unknown resolves to '' (surfaces as required).
assert.equal(eTransportCodJudet('3'), '3');
assert.equal(eTransportCodJudet('Freistaat Bayern'), '');

const incompleteXml = buildETransportXml({
  ...base,
  goods: [{ description: 'Date încă neverificate' }],
});
assert.doesNotMatch(incompleteXml, /codTarifar="8703"/);
assert.doesNotMatch(incompleteXml, /greutateBruta="1500"/);

const rate = parseBnrRateXml(
  '<DataSet><Body><Cube date="2026-07-24"><Rate currency="EUR">5.2348</Rate><Rate currency="HUF" multiplier="100">1.4434</Rate></Cube></Body></DataSet>',
  'EUR',
);
assert.deepEqual(rate, { currency: 'EUR', rate: 5.2348, rateDate: '2026-07-24' });
assert.equal(
  parseBnrRateXml(
    '<DataSet><Body><Cube date="2026-07-24"><Rate currency="HUF" multiplier="100">1.4434</Rate></Cube></Body></DataSet>',
    'HUF',
  ).rate,
  0.014434,
);

assert.equal(validityDaysForOperation('AIC'), 15);
assert.equal(validityDaysForOperation('IMP'), 5);

const selectedSource = selectUitPurchaseSource(
  [
    {
      id: 1,
      type: 'Contract',
      processedData: {
        extractedFields: {
          document_type: 'Contract',
          direction: 'incoming',
          vehicle_transaction: 'purchase',
          contract_type: 'achizitie',
          vin: 'WBA12345678901234',
          total_amount: 12_000,
          currency: 'EUR',
        },
      },
    },
    {
      id: 2,
      type: 'Invoice',
      processedData: {
        extractedFields: {
          document_type: 'Invoice',
          direction: 'incoming',
          vehicle_transaction: 'purchase',
          vin: 'WBA12345678901234',
          total_amount: 11_900,
          vat_amount: 0,
          currency: 'EUR',
          line_items: [{ name: 'Autoturism', account_code: '371', total: 11_900 }],
        },
      },
    },
    {
      id: 3,
      type: 'CMR',
      processedData: { extractedFields: { gross_weight_kg: 1_500 } },
    },
  ],
  '31194616',
);
assert.equal(selectedSource?.document.id, 2);

async function verifyDriveWorkbookParsing() {
  assert.equal(parseVehicleWeightKg(1530), 1530);
  assert.equal(parseVehicleWeightKg('1.530 kg'), 1530);
  assert.equal(parseVehicleWeightKg('1530,5'), 1530.5);

  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Parc auto" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  const strings = [
    'COD INTERN',
    'SERIE SASIU',
    'MASA',
    'LOCATIE',
    'AUTO-001',
    'WBA12345678901234',
    '1.530 kg',
    'București',
  ];
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0"?><sst>${strings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0"?><worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" t="s"><v>6</v></c><c r="D2" t="s"><v>7</v></c></row>' +
      '</sheetData></worksheet>',
  );
  const workbook = await parseVehicleWorkbook(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(workbook.sheetName, 'Parc auto');
  assert.deepEqual(workbook.rows, [
    {
      vin: 'WBA12345678901234',
      weightKg: 1530,
      unloadingCity: 'București',
      rowNumber: 2,
    },
  ]);

  const invalidCredentials = new DriveVehicleDataService(
    new ConfigService({
      ETRANSPORT_DRIVE_FILE_ID: 'test-file-id',
      GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: 'not-json-or-base64-json',
    }),
  );
  const status = await invalidCredentials.status();
  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
  assert.match(String((status as any).error), /Credentialele Google Drive/);

  const auditEntries: any[] = [];
  let storedDeclaration: any = {
    id: 41,
    tenantId: 7,
    status: 'DRAFT',
    operationType: 'AIC',
    vehicleId: 9,
  };
  const draftService = new EtransportService(
    {
      eTransportDeclaration: {
        findFirst: async ({ where }: any) =>
          storedDeclaration?.id === where.id && storedDeclaration?.tenantId === where.tenantId
            ? storedDeclaration
            : null,
        delete: async ({ where }: any) => {
          assert.equal(where.id, storedDeclaration.id);
          storedDeclaration = null;
        },
      },
    } as any,
    {} as any,
    { log: async (entry: any) => auditEntries.push(entry) } as any,
    {} as any,
    {} as any,
    {} as any,
  );
  assert.deepEqual(await draftService.removeDraft(7, 3, 41), { id: 41, deleted: true });
  assert.equal(storedDeclaration, null);
  assert.equal(auditEntries[0]?.action, 'etransport.draft_deleted');

  storedDeclaration = { id: 42, tenantId: 7, status: 'SUBMITTED', operationType: 'AIC' };
  await assert.rejects(
    () => draftService.removeDraft(7, 3, 42),
    /Poți șterge doar ciornele/,
  );

  let confirmedDeclaration: any = {
    id: 43,
    tenantId: 7,
    status: 'CONFIRMED',
    operationType: 'AIC',
    uit: '5F3P2L8P0T8D1574',
    validUntil: new Date(Date.now() + 86_400_000),
  };
  const infirmationAudits: any[] = [];
  let infirmationStatus: 'CONFIRMED' | 'REJECTED' = 'CONFIRMED';
  const infirmationService = new EtransportService(
    {
      tenant: { findUnique: async () => ({ cui: '31194616' }) },
      eTransportDeclaration: {
        findFirst: async () => confirmedDeclaration,
        findMany: async () =>
          confirmedDeclaration.status === 'INFIRMING' ? [confirmedDeclaration] : [],
        update: async ({ data }: any) => {
          confirmedDeclaration = { ...confirmedDeclaration, ...data };
          return confirmedDeclaration;
        },
      },
    } as any,
    {
      configured: true,
      submitDeclaration: async (_tenantId: number, cui: string, xmlPayload: string) => {
        assert.equal(cui, '31194616');
        assert.match(xmlPayload, /<confirmare[^>]*tipConfirmare="30"/);
        assert.match(xmlPayload, /uit="5F3P2L8P0T8D1574"/);
        return '5060642999';
      },
      checkStatus: async () => ({
        status: infirmationStatus,
        raw: infirmationStatus === 'CONFIRMED' ? '{"stare":"ok"}' : '{"stare":"nok"}',
      }),
    } as any,
    { log: async (entry: any) => infirmationAudits.push(entry) } as any,
    {} as any,
    {} as any,
    {} as any,
  );
  await infirmationService.infirm(7, 3, 43, 'Transport anulat & neefectuat');
  assert.equal(confirmedDeclaration.status, 'INFIRMING');
  assert.equal(confirmedDeclaration.infirmationUploadId, '5060642999');
  assert.equal(infirmationAudits[0]?.action, 'etransport.infirmation_submitted');
  await infirmationService.pollStatuses();
  assert.equal(confirmedDeclaration.status, 'INFIRMED');
  assert.ok(confirmedDeclaration.infirmedAt instanceof Date);
  assert.equal(infirmationAudits[1]?.action, 'etransport.infirmed');

  confirmedDeclaration = {
    ...confirmedDeclaration,
    id: 44,
    status: 'CONFIRMED',
    infirmationUploadId: null,
    infirmationResponse: null,
    infirmedAt: null,
  };
  infirmationStatus = 'REJECTED';
  await infirmationService.infirm(7, 3, 44, 'Transport neefectuat');
  await infirmationService.pollStatuses();
  assert.equal(confirmedDeclaration.status, 'CONFIRMED');
  assert.equal(
    infirmationAudits[infirmationAudits.length - 1]?.action,
    'etransport.infirmation_rejected',
  );
}

verifyDriveWorkbookParsing()
  .then(() => {
    console.log(
      'e-Transport tests passed: Drive XLSX/VIN lookup, invoice-first prefill, BNR parsing, operation codes and UIT validity.',
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
