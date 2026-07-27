import assert from 'node:assert/strict';
import { parseBnrRateXml } from '../src/etransport/bnr-rate';
import { validityDaysForOperation } from '../src/etransport/etransport.service';
import { buildETransportXml, DeclarationData } from '../src/etransport/xml-builder';

const base: DeclarationData = {
  tenantCui: '12345678',
  operationType: 'AIC',
  transporter: { name: 'Transportator verificat', taxId: 'DE123', country: 'DE' },
  vehiclePlate: 'B123UIT',
  loadingPlace: { country: 'DE', city: 'Berlin' },
  unloadingPlace: { country: 'RO', county: 'B', city: 'București' },
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
assert.match(xml, /<codTipOperatiune>10<\/codTipOperatiune>/);
assert.match(xml, /<codTarifar>87032390<\/codTarifar>/);
assert.match(xml, /<greutateBruta>1327<\/greutateBruta>/);
assert.match(xml, /<valoareLeiFaraTva>65000\.25<\/valoareLeiFaraTva>/);

const incompleteXml = buildETransportXml({
  ...base,
  goods: [{ description: 'Date încă neverificate' }],
});
assert.doesNotMatch(incompleteXml, /<codTarifar>8703<\/codTarifar>/);
assert.doesNotMatch(incompleteXml, /<greutateBruta>1500<\/greutateBruta>/);

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

console.log('e-Transport tests passed: no placeholder fallbacks, BNR parsing, operation codes and UIT validity.');
