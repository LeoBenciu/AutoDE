import assert from 'node:assert/strict';
import { normalizeAccountingDocument } from '../src/accounting/accounting-normalizer';
import { sagaInvoicesFileName } from '../src/saga/saga.service';
import { buildFacturiXml, SagaCompany } from '../src/saga/saga-xml';

const company: SagaCompany = {
  cui: '31194616',
  name: 'B.R.T COMPANY GROUP SRL',
  registrationNumber: 'J04/123/2013',
  address: 'Str. Companiei 1',
  country: 'RO',
  county: 'BC',
  city: 'Bacău',
  phone: '+40 700 000 000',
  email: 'office@brt.example',
  isVatPayer: true,
  hasTvaLaIncasare: true,
};

const reverseCharge = {
  id: 10,
  type: 'Invoice',
  data: normalizeAccountingDocument(
    'Invoice',
    {
      document_type: 'Invoice',
      direction: 'incoming',
      vendor: 'AUTO1 Group Operations SE',
      vendor_ein: 'DE286118911',
      vendor_country: 'DE',
      vendor_address: 'Bergmannstr. 72',
      vendor_city: 'Berlin',
      vendor_phone: '+49 30 2016 3836',
      vendor_email: 'info@auto1.com',
      buyer: 'B.R.T COMPANY GROUP SRL',
      buyer_ein: '31194616',
      buyer_country: 'RO',
      document_number: '10026010798614',
      document_date: '23-07-2026',
      total_amount: 665,
      vat_amount: 0,
      reverse_charge: true,
      vat_on_collection: false,
      currency: 'EUR',
      vehicle_transaction: 'cost',
      line_items: [
        {
          name: 'Handling fee',
          quantity: 1,
          unit_price: 665,
          total: 665,
          vat_amount: 0,
          vat: 'ZERO',
          account_code: '628',
          articleCode: 'KL94218',
          selectedArticleAnalitic: '00001',
          article_type: 'MARFURI',
          management: 'STOC',
        },
      ],
    },
    company.cui,
  ),
};

const reverseXml = buildFacturiXml([reverseCharge], company, []);
assert.match(reverseXml, /<FacturaTaxareInversa>Da<\/FacturaTaxareInversa>/);
assert.match(reverseXml, /<FacturaTVAIncasare>Nu<\/FacturaTVAIncasare>/);
assert.match(reverseXml, /<FacturaTip>T<\/FacturaTip>/);
assert.match(reverseXml, /<ProcTVA>21<\/ProcTVA>/);
assert.match(reverseXml, /<TVA>0<\/TVA>/);
assert.match(reverseXml, /<FurnizorLocalitate>Berlin<\/FurnizorLocalitate>/);
assert.match(reverseXml, /<FurnizorAdresa>Bergmannstr\. 72<\/FurnizorAdresa>/);
assert.match(reverseXml, /<ClientLocalitate>Bacău<\/ClientLocalitate>/);
assert.match(reverseXml, /<ClientAdresa>Str\. Companiei 1<\/ClientAdresa>/);
assert.match(reverseXml, /<CodArticolFurnizor><\/CodArticolFurnizor>/);
assert.match(reverseXml, /<CodArticolClient><\/CodArticolClient>/);
assert.equal(reverseCharge.data.lineItems[0].articleCode, '');
assert.equal(reverseCharge.data.lineItems[0].articleType, 'Nedefinit');
assert.equal(reverseCharge.data.lineItems[0].management, undefined);

const contract = normalizeAccountingDocument(
  'Contract',
  {
    direction: 'incoming',
    contract_number: 'FICTIV-001/2026',
    contract_date: '31-07-2026',
    total_value: 62_500,
    currency: 'RON',
    vehicle_transaction: 'purchase',
    vin: 'WVWZZZ3CZGE123456',
    parties: [
      {
        name: 'Andrei-Mihai Popescu',
        ein: '5050217041556',
        role: 'vendor',
        kind: 'INDIVIDUAL',
        identifier_type: 'CNP',
        country: 'RO',
        address: 'Str. Exemplului 10',
        city: 'Bacău',
        county: 'BC',
        phone: '+40 700 111 222',
        email: 'andrei@example.test',
      },
      {
        name: company.name,
        ein: company.cui,
        role: 'client',
        kind: 'COMPANY',
        identifier_type: 'CUI',
        country: 'RO',
      },
    ],
  },
  company.cui,
);
assert.equal(contract.vendorAddress, 'Str. Exemplului 10');
assert.equal(contract.vendorCity, 'Bacău');
assert.equal(contract.vendorPhone, '+40 700 111 222');
assert.equal(contract.vendorEmail, 'andrei@example.test');
const contractXml = buildFacturiXml(
  [{ id: 13, type: 'Contract', data: contract }],
  company,
  [],
);
assert.match(contractXml, /<FacturaTip>R<\/FacturaTip>/);
// A private-seller vehicle purchase carries no VAT, so its line must not be
// tagged non-deductible (TipDeducere=I); the deduction type stays blank.
assert.doesNotMatch(contractXml, /<TipDeducere>I<\/TipDeducere>/);
assert.match(contractXml, /<TipDeducere><\/TipDeducere>/);

// A purchase contract may be split across lines like an invoice (car on 371,
// transport on 624). The normalizer keeps the supplied lines and SAGA exports
// each on its own account with a blank deduction type.
const splitContract = normalizeAccountingDocument(
  'Contract',
  {
    direction: 'incoming',
    contract_number: 'FICTIV-002/2026',
    contract_date: '31-07-2026',
    total_value: 50_500,
    currency: 'RON',
    vehicle_transaction: 'purchase',
    vin: 'WVWZZZ3CZGE654321',
    vehicle_make: 'Skoda',
    vehicle_model: 'Octavia',
    line_items: [
      {
        name: 'Autoturism',
        account_code: '371',
        quantity: 1,
        unit_price: 50_000,
        total: 50_000,
        vat_amount: 0,
        vat: 'ZERO',
        vat_deductibility: 'FULL',
        um: 'BUCATA',
      },
      {
        name: 'Transport',
        account_code: '624',
        quantity: 1,
        unit_price: 500,
        total: 500,
        vat_amount: 0,
        vat: 'ZERO',
        vat_deductibility: 'FULL',
        um: 'BUCATA',
      },
    ],
    parties: [
      {
        name: 'Vasile Vânzător',
        ein: '1900101223344',
        role: 'vendor',
        kind: 'INDIVIDUAL',
        identifier_type: 'CNP',
        country: 'RO',
      },
      {
        name: company.name,
        ein: company.cui,
        role: 'client',
        kind: 'COMPANY',
        identifier_type: 'CUI',
        country: 'RO',
      },
    ],
  },
  company.cui,
);
assert.equal(splitContract.lineItems.length, 2);
// The car line keeps the AUTO-VIN stock identity; the transport line does not.
assert.equal(splitContract.lineItems[0].articleCode, 'AUTO-WVWZZZ3CZGE654321');
assert.equal(splitContract.lineItems[1].accountCode, '624');
const splitXml = buildFacturiXml(
  [{ id: 14, type: 'Contract', data: splitContract }],
  company,
  [],
);
assert.match(splitXml, /<Cont>371<\/Cont>/);
assert.match(splitXml, /<Cont>624<\/Cont>/);
assert.doesNotMatch(splitXml, /<TipDeducere>I<\/TipDeducere>/);

assert.equal(
  sagaInvoicesFileName(company.cui, '2026-07-23'),
  'F_31194616_2026-07-23.xml',
);

const outgoing = {
  id: 11,
  type: 'Invoice',
  data: normalizeAccountingDocument(
    'Invoice',
    {
      direction: 'outgoing',
      vendor: company.name,
      vendor_ein: company.cui,
      vendor_country: 'RO',
      buyer: 'Client SRL',
      buyer_ein: '12345678',
      buyer_country: 'RO',
      document_number: 'IES-1',
      document_date: '23-07-2026',
      total_amount: 121,
      vat_amount: 21,
      line_items: [
        {
          name: 'Serviciu',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 21,
          vat: 'TWENTYONE',
          account_code: '704',
        },
      ],
    },
    company.cui,
  ),
};
assert.match(
  buildFacturiXml([outgoing], company, []),
  /<FacturaTVAIncasare>Da<\/FacturaTVAIncasare>/,
);

const foreignVatInvoice = {
  ...outgoing,
  id: 12,
  data: normalizeAccountingDocument(
    'Invoice',
    {
      ...outgoing.data.raw,
      direction: 'incoming',
      vendor: 'Foreign Supplier GmbH',
      vendor_ein: 'DE123456789',
      vendor_country: 'DE',
      buyer: company.name,
      buyer_ein: company.cui,
      vat_on_collection: true,
    },
    company.cui,
  ),
};
assert.match(
  buildFacturiXml([foreignVatInvoice], company, []),
  /<FacturaTVAIncasare>Nu<\/FacturaTVAIncasare>/,
);

console.log('saga-regressions.spec.ts passed');
