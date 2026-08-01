import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderContractPdf } from '../src/contracts/contract-pdf';
import {
  ContractTemplateData,
  DEFAULT_HANDOVER_PROTOCOL_TEMPLATE,
  DEFAULT_SALE_CONTRACT_TEMPLATE,
  misplacedBlockPlaceholders,
  substituteTemplateLine,
  templateValues,
  unknownTemplatePlaceholders,
} from '../src/contracts/contract-templates';
import { amountInWords } from '../src/contracts/ro-words';

const data: ContractTemplateData = {
  contractNumber: 'CV-00001',
  date: '01.08.2026',
  seller: {
    name: 'NEXT CORP S.R.L.',
    taxId: '47935139',
    registration: 'J04/1234/2024',
    address:
      'JUD. BACĂU, SAT PÂNCEȘTI, COM. SASCUȚ, STR. PRINCIPALĂ NR. 55',
    city: 'Sascuț',
    county: 'Bacău',
    country: 'RO',
    iban: 'RO49AAAA1B31007593840000',
    bankName: 'Banca Română',
    email: 'office@next.example',
    phone: '+40 721 000 000',
  },
  buyer: {
    name: 'Șerban-Țăndărică Ionuț',
    kind: 'INDIVIDUAL',
    identifierType: 'CNP',
    taxId: '1900101223344',
    address: 'Str. Mărășești nr. 25, Pâncești, Bacău',
    city: 'Pâncești',
    county: 'Bacău',
    country: 'RO',
  },
  vehicle: {
    make: 'Volkswagen',
    model: 'Passat',
    variant: 'Variant B8 2.0 TDI',
    vin: 'WVWZZZ3CZJE000000',
    year: 2018,
    firstRegistered: '15.03.2018',
    mileageKm: 145_320,
    color: 'Gri metalizat',
  },
  price: 100_000,
  currency: 'RON',
  priceInWords: amountInWords(100_000, 'RON'),
};

assert.deepEqual(unknownTemplatePlaceholders(DEFAULT_SALE_CONTRACT_TEMPLATE), []);
assert.deepEqual(
  unknownTemplatePlaceholders(DEFAULT_HANDOVER_PROTOCOL_TEMPLATE),
  [],
);
assert.deepEqual(unknownTemplatePlaceholders('{{buyer_name}} {{wrong_field}}'), [
  '{{wrong_field}}',
]);
assert.deepEqual(unknownTemplatePlaceholders('{{buyer-name}}'), [
  '{{buyer-name}}',
]);
assert.deepEqual(
  misplacedBlockPlaceholders('Date auto: {{vehicle_details}}'),
  ['{{vehicle_details}}'],
);
assert.equal(
  substituteTemplateLine(
    'Cumpărător: {{buyer_name}} din {{buyer_city}}',
    templateValues(data),
  ),
  'Cumpărător: Șerban-Țăndărică Ionuț din Pâncești',
);

void (async () => {
  const sale = await renderContractPdf(DEFAULT_SALE_CONTRACT_TEMPLATE, data);
  const handover = await renderContractPdf(
    DEFAULT_HANDOVER_PROTOCOL_TEMPLATE,
    { ...data, contractNumber: 'PV-00001' },
  );
  for (const pdf of [sale, handover]) {
    assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
    assert.ok(pdf.length > 20_000, 'Unicode fonts should be embedded in the PDF');
  }

  const outputDir = process.env.CONTRACT_PDF_OUTPUT_DIR;
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
      writeFile(join(outputDir, 'contract-vanzare-cumparare.pdf'), sale),
      writeFile(join(outputDir, 'proces-verbal-predare-primire.pdf'), handover),
    ]);
  }

  console.log('contracts-pdf.spec.ts passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
