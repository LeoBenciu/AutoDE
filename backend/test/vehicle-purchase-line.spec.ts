import assert from 'node:assert/strict';
import { normalizeAccountingDocument } from '../src/accounting/accounting-normalizer';
import {
  applyVehicleCostAccountDefaults,
  applyVehiclePurchaseInvoiceDefaults,
  defaultVehicleCostCategoryForAccount,
  isVehicleCostDocument,
  vehicleAccountingReviewErrors,
  vehicleCostReviewErrors,
} from '../src/vehicles/vehicle-document-sync';

const VIN = 'WBA12345678901234';

function purchaseInvoiceFields() {
  return {
    document_type: 'Invoice',
    vehicle_transaction: 'purchase',
    vin: VIN,
    vehicle_make: 'BMW',
    vehicle_model: 'Seria 3',
    vehicle_variant: '320d',
    total_amount: 20000,
    vat_amount: 0,
    line_items: [
      {
        name: 'Marfa conform facturii',
        account_code: '371',
        quantity: 1,
        unit_price: 20000,
        total: 20000,
        management: '',
      },
    ],
  } as Record<string, any>;
}

// 1. Brand-organized managements: description becomes the model, gestiune the brand.
{
  const fields = purchaseInvoiceFields();
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'G-BMW', name: 'BMW' },
    { code: 'G-AUDI', name: 'Audi' },
  ]);
  assert.equal(changed, true);
  assert.equal(fields.line_items[0].name, 'BMW Seria 3 320d');
  assert.equal(fields.line_items[0].management, 'G-BMW');
  assert.equal(fields.line_items[0].articleCode, `AUTO-${VIN}`);
}

// 2. No brand-matched management: description is still set, gestiune left untouched.
{
  const fields = purchaseInvoiceFields();
  fields.line_items[0].articleCode = 'EXISTING-SEMANTIC-MATCH';
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'DEPOZIT', name: 'Depozit central' },
  ]);
  assert.equal(changed, true);
  assert.equal(fields.line_items[0].name, 'BMW Seria 3 320d');
  assert.equal(fields.line_items[0].management, '');
  assert.equal(
    fields.line_items[0].articleCode,
    `AUTO-${VIN}`,
    'a purchase vehicle must not reuse a semantically matched article',
  );
}

// 3. Hyphenated brand matches a shorter brand gestiune by prefix.
{
  const fields = purchaseInvoiceFields();
  fields.vehicle_make = 'Mercedes-Benz';
  fields.vehicle_model = 'C 220';
  fields.vehicle_variant = undefined;
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'G-MB', name: 'Mercedes' },
  ]);
  assert.equal(changed, true);
  assert.equal(fields.line_items[0].name, 'Mercedes-Benz C 220');
  assert.equal(fields.line_items[0].management, 'G-MB');
}

// 4. Non-vehicle invoices are left completely untouched.
{
  const fields = {
    document_type: 'Invoice',
    total_amount: 500,
    vat_amount: 0,
    line_items: [
      { name: 'Servicii consultanță', account_code: '628', total: 500, management: 'X' },
    ],
  } as Record<string, any>;
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'G-BMW', name: 'BMW' },
  ]);
  assert.equal(changed, false);
  assert.equal(fields.line_items[0].name, 'Servicii consultanță');
  assert.equal(fields.line_items[0].management, 'X');
}

// 5. Only the car stays on 371. Transport uses 624 and every other ancillary
//    service or tax uses 628, without a stock article or gestiune.
{
  const fields = purchaseInvoiceFields();
  fields.line_items = [
    { name: 'Autoturism', account_code: '371', total: 20000, management: '' },
    { name: 'Transport', account_code: '371', total: 500, management: 'G-BMW' },
    { name: 'Document handling fee', account_code: '371', total: 100, management: 'G-BMW' },
  ];
  fields.total_amount = 20600;
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'G-BMW', name: 'BMW' },
  ]);
  assert.equal(changed, true);
  assert.equal(fields.line_items[0].name, 'BMW Seria 3 320d');
  assert.equal(fields.line_items[0].management, 'G-BMW');
  assert.equal(fields.line_items[1].name, 'Transport');
  assert.equal(fields.line_items[1].account_code, '624');
  assert.equal(fields.line_items[1].management, null);
  assert.equal(fields.line_items[2].account_code, '628');
  assert.equal(fields.line_items[2].management, null);
}

// 6. A German "Fahrzeugtransport" line is recognized and kept out of 371.
{
  const fields = purchaseInvoiceFields();
  fields.line_items = [
    { name: 'BMW 320d', account_code: '371', total: 20000, management: '' },
    {
      name: 'Fahrzeugtransport Seddiner See - Bacau',
      account_code: '371',
      total: 665,
      management: '',
    },
  ];
  fields.total_amount = 20665;
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'DEPOZIT', name: 'Depozit central' },
  ]);
  assert.equal(changed, true);
  assert.equal(fields.line_items[1].account_code, '624');
  assert.equal(fields.line_items[1].name, 'Fahrzeugtransport Seddiner See - Bacau');
  assert.equal(fields.line_items[1].management, '');
}

// 7. Re-running on already-normalized fields is idempotent (no further change).
{
  const fields = purchaseInvoiceFields();
  fields.line_items = [
    { name: 'Autoturism', account_code: '371', total: 20000, management: '' },
    { name: 'Transport', account_code: '624', total: 500, management: '' },
  ];
  fields.total_amount = 20500;
  const managements = [{ code: 'G-BMW', name: 'BMW' }];
  assert.equal(applyVehiclePurchaseInvoiceDefaults(fields, managements), true);
  assert.equal(applyVehiclePurchaseInvoiceDefaults(fields, managements), false);
}

// 8. Vehicle-cost extraction enforces 624 for transport and 628 for all other
//    categories. Only 624 has an unambiguous automatic category.
{
  assert.equal(defaultVehicleCostCategoryForAccount('624'), 'TRANSPORT');
  assert.equal(defaultVehicleCostCategoryForAccount('624.01'), 'TRANSPORT');
  assert.equal(defaultVehicleCostCategoryForAccount('611'), undefined);
  assert.equal(defaultVehicleCostCategoryForAccount('6024'), undefined);
  assert.equal(defaultVehicleCostCategoryForAccount('628'), undefined);

  const costFields = {
    direction: 'incoming',
    vehicle_transaction: 'cost',
    line_items: [
      {
        name: 'Reparație',
        account_code: '611',
        vehicle_cost_category: 'REFURB',
        articleCode: 'SERVICE-1',
        isNew: true,
        management: 'G-BMW',
      },
      {
        name: 'Transport platformă',
        account_code: '371',
        vehicle_cost_category: 'TRANSPORT',
      },
    ],
  } as Record<string, any>;
  assert.equal(applyVehicleCostAccountDefaults('Invoice', costFields), true);
  assert.equal(costFields.line_items[0].account_code, '628');
  assert.equal(costFields.line_items[0].articleCode, '');
  assert.equal(costFields.line_items[0].isNew, false);
  assert.equal(costFields.line_items[0].management, null);
  assert.equal(costFields.line_items[1].account_code, '624');

  const reviewErrors = (
    accountCode: string,
    vehicleCostCategory?: string,
    categoriesReviewed = true,
  ) => {
    const fields = {
      direction: 'incoming',
      vehicle_transaction: 'cost',
      vehicle_cost_categories_reviewed: categoriesReviewed,
      total_amount: 100,
      vat_amount: 0,
      line_items: [
        {
          name: 'Cost vehicul',
          quantity: 1,
          unit_price: 100,
          total: 100,
          vat_amount: 0,
          account_code: accountCode,
          ...(vehicleCostCategory
            ? { vehicle_cost_category: vehicleCostCategory }
            : {}),
        },
      ],
    };
    return vehicleCostReviewErrors(
      normalizeAccountingDocument('Invoice', fields),
      1,
    );
  };

  assert.deepEqual(reviewErrors('624'), []);
  assert.deepEqual(reviewErrors('611'), [
    'Selectează categoria de cost pentru linia 1',
  ]);
  assert.deepEqual(reviewErrors('6024'), [
    'Selectează categoria de cost pentru linia 1',
  ]);
  assert.deepEqual(reviewErrors('628'), [
    'Selectează categoria de cost pentru linia 1',
  ]);
  assert.deepEqual(reviewErrors('624', undefined, false), []);
  assert.deepEqual(reviewErrors('624', 'OTHER', false), [
    'Linia 1 „Cost vehicul” trebuie să folosească contul 628',
  ]);
  assert.deepEqual(reviewErrors('628', 'ITP', false), [
    'Confirmă categoriile de cost înainte de aprobare',
  ]);
  assert.deepEqual(reviewErrors('628', 'ITP'), []);
  assert.deepEqual(reviewErrors('611', 'ITP'), [
    'Linia 1 „Cost vehicul” trebuie să folosească contul 628',
  ]);
}

// 9. Approval rejects a purchase invoice if transport or an ancillary service
//    is placed on the car's 371 account.
{
  const fields = purchaseInvoiceFields();
  fields.line_items = [
    { name: 'Autoturism BMW', account_code: '371', total: 20000 },
    { name: 'Transport', account_code: '371', total: 500 },
    { name: 'Document handling fee', account_code: '371', total: 100 },
  ];
  const errors = vehicleAccountingReviewErrors(
    normalizeAccountingDocument('Invoice', fields),
  );
  assert.deepEqual(errors, [
    'Linia 2 „Transport” trebuie să folosească contul 624 (transport)',
    'Linia 3 „Document handling fee” trebuie să folosească contul 628 (servicii și taxe asociate)',
  ]);
  applyVehiclePurchaseInvoiceDefaults(fields, []);
  assert.deepEqual(
    vehicleAccountingReviewErrors(normalizeAccountingDocument('Invoice', fields)),
    [],
  );
}

// 10. Posting normalization enforces the full-VIN article even if extraction or
//    a correction supplies an existing generic article code.
{
  const first = purchaseInvoiceFields();
  first.line_items[0].articleCode = 'EXISTING-CAR';
  const second = purchaseInvoiceFields();
  // Same final eight characters as VIN, but a different full VIN.
  second.vin = 'WVWZZZ1JZ78901234';
  second.line_items[0].articleCode = 'EXISTING-CAR';

  assert.equal(
    normalizeAccountingDocument('Invoice', first).lineItems[0].articleCode,
    `AUTO-${VIN}`,
  );
  assert.equal(
    normalizeAccountingDocument('Invoice', second).lineItems[0].articleCode,
    'AUTO-WVWZZZ1JZ78901234',
  );
}

// 11. A normal receipt is not forced into the vehicle-cost workflow merely
//     because extraction guessed a vehicle category. Explicit user association
//     is the only thing that turns it into a vehicle cost.
{
  const fields = {
    direction: 'incoming',
    receipt_type: 'independent_receipt',
    total_amount: 49.91,
    vat_amount: 8.66,
    line_items: [
      {
        name: 'Benzina Standard 95',
        quantity: 5.3898,
        unit_price: 7.653,
        total: 41.25,
        vat_amount: 8.66,
        account_code: '6022',
        vehicle_cost_category: 'OTHER',
      },
    ],
  } as Record<string, any>;
  const canonical = normalizeAccountingDocument('Receipt', fields);

  assert.equal(isVehicleCostDocument(canonical), false);
  assert.deepEqual(vehicleCostReviewErrors(canonical), []);
  assert.equal(applyVehicleCostAccountDefaults('Receipt', fields), false);
  assert.equal(fields.line_items[0].account_code, '6022');

  assert.equal(isVehicleCostDocument(canonical, 1), true);
}

console.log('vehicle-purchase-line.spec.ts passed');
