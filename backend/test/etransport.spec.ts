import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import JSZip = require('jszip');
import { parseBnrRateXml } from '../src/etransport/bnr-rate';
import {
  DriveVehicleDataService,
  parseVehicleWeightKg,
  parseVehicleWorkbook,
} from '../src/etransport/drive-vehicle-data.service';
import {
  selectUitPurchaseSource,
  validityDaysForOperation,
} from '../src/etransport/etransport.service';
import { buildETransportXml, DeclarationData } from '../src/etransport/xml-builder';
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
assert.match(xml, /codTarifar="87032390"/);
assert.match(xml, /greutateBruta="1327"/);
assert.match(xml, /valoareLeiFaraTva="65000\.25"/);
assert.match(xml, /<partenerComercial codTara="DE"/);
assert.match(xml, /<dateTransport nrVehicul="B123UIT"/);
// The border crossing point is not declared unless explicitly provided.
assert.doesNotMatch(xml, /codPtf=/);
// Unloading place is a Romanian locatie whose county is emitted as the numeric
// ANAF codJudet (București "B" → 40), never the 2-letter plate code.
assert.match(xml, /<locFinalTraseuRutier>\s*<locatie codJudet="40"/);
// codJudet, denumireLocalitate and denumireStrada are all mandatory (minLength 1);
// they must be emitted non-empty for a Romanian locatie.
assert.match(xml, /denumireLocalitate="București"/);
assert.match(xml, /denumireStrada="Str\. Exemplu 1"/);

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
