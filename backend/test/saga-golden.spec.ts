import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAccountingDocument } from '../src/accounting/accounting-normalizer';
import {
  buildArticlesXml,
  buildFacturiXml,
  buildIncasariXml,
  buildPartnersXml,
  buildPlatiXml,
} from '../src/saga/saga-xml';
import {
  finovaArticles,
  finovaFacturi,
  finovaMovements,
  finovaPartners,
} from './finova-saga-reference';
import {
  articles,
  clients,
  company,
  finovaCommit,
  payments,
  rawInvoices,
  receipts,
  suppliers,
} from './fixtures/saga-finova/fixture';

const fixtureDir = join(__dirname, 'fixtures', 'saga-finova', 'golden');

const production = {
  facturi: buildFacturiXml(
    rawInvoices.map((invoice) => ({
      id: invoice.id,
      type: invoice.type,
      data: normalizeAccountingDocument(
        invoice.type,
        invoice.fields,
        company.cui,
      ),
    })),
    company,
    articles,
  ),
  incasari: buildIncasariXml(receipts),
  plati: buildPlatiXml(payments),
  furnizori: buildPartnersXml('Furnizori', suppliers),
  clienti: buildPartnersXml('Clienti', clients),
  articole: buildArticlesXml(articles),
};

const reference = {
  facturi: finovaFacturi(
    rawInvoices,
    company,
    articles.map((article) => ({
      code: article.code,
      name: article.name,
      analitic: article.analyticCode,
      vat: article.vatRate,
      unitOfMeasure: article.unit,
      type: article.type,
    })),
  ),
  incasari: finovaMovements(
    'Incasari',
    receipts.map((movement) => ({
      ...movement,
      clientAccount: movement.counterAccount,
    })),
  ),
  plati: finovaMovements(
    'Plati',
    payments.map((movement) => ({
      ...movement,
      supplierAccount: movement.counterAccount,
    })),
  ),
  furnizori: finovaPartners(
    'Furnizori',
    suppliers.map(toFinovaPartner),
  ),
  clienti: finovaPartners('Clienti', clients.map(toFinovaPartner)),
  articole: finovaArticles(
    articles.map((article) => ({
      code: article.code,
      name: article.name,
      analitic: article.analyticCode,
      vat: article.vatRate,
      unitOfMeasure: article.unit,
      type: article.type,
    })),
  ),
};

if (process.env.UPDATE_SAGA_GOLDEN === '1') {
  mkdirSync(fixtureDir, { recursive: true });
  for (const [name, xml] of Object.entries(reference)) {
    writeFileSync(join(fixtureDir, `${name}.xml`), xml, 'utf8');
  }
}

for (const name of Object.keys(reference) as Array<keyof typeof reference>) {
  const path = join(fixtureDir, `${name}.xml`);
  assert.ok(
    existsSync(path),
    `Missing ${name}.xml. Regenerate only after reviewing Finova commit ${finovaCommit}.`,
  );
  const golden = readFileSync(path, 'utf8');
  assert.equal(
    reference[name],
    golden,
    `${name}: committed golden no longer matches Finova reference ${finovaCommit}`,
  );
  assert.equal(
    production[name],
    golden,
    `${name}: AutoImport output differs byte-for-byte from Finova`,
  );
}

console.log(
  `All six SAGA XML files match Finova ${finovaCommit} byte-for-byte.`,
);

function toFinovaPartner(partner: (typeof suppliers)[number] | (typeof clients)[number]) {
  return {
    name: partner.name,
    ein: partner.taxId,
    regCom: partner.registration,
    tara: partner.country,
    judet: partner.county,
    localitate: partner.city,
    address: partner.address,
    contBancar: partner.iban,
    banca: partner.bankName,
    phone: partner.phone,
    email: partner.email,
    discount: partner.discount,
    code: partner.code,
    analitic: partner.analytic,
  };
}
