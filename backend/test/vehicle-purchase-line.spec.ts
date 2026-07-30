import assert from 'node:assert/strict';
import { normalizeAccountingDocument } from '../src/accounting/accounting-normalizer';
import {
  applyVehiclePurchaseInvoiceDefaults,
  defaultVehicleCostCategoryForAccount,
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

// 5. Freight-in on the purchase invoice is capitalized into 371 on the car's
//    gestiune, while the stock line is enriched with the model identity.
{
  const fields = purchaseInvoiceFields();
  fields.line_items = [
    { name: 'Autoturism', account_code: '371', total: 20000, management: '' },
    { name: 'Transport', account_code: '624', total: 500, management: '' },
  ];
  fields.total_amount = 20500;
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'G-BMW', name: 'BMW' },
  ]);
  assert.equal(changed, true);
  assert.equal(fields.line_items[0].name, 'BMW Seria 3 320d');
  assert.equal(fields.line_items[0].management, 'G-BMW');
  // Freight-in line: re-posted to 371 on the same gestiune, name left intact.
  assert.equal(fields.line_items[1].name, 'Transport');
  assert.equal(fields.line_items[1].account_code, '371');
  assert.equal(fields.line_items[1].management, 'G-BMW');
}

// 6. A German "Fahrzeugtransport" freight line is captured even with no brand
//    gestiune; the account flips to 371 but the management is left untouched.
{
  const fields = purchaseInvoiceFields();
  fields.line_items = [
    { name: 'BMW 320d', account_code: '371', total: 20000, management: '' },
    {
      name: 'Fahrzeugtransport Seddiner See - Bacau',
      account_code: '624',
      total: 665,
      management: '',
    },
  ];
  fields.total_amount = 20665;
  const changed = applyVehiclePurchaseInvoiceDefaults(fields, [
    { code: 'DEPOZIT', name: 'Depozit central' },
  ]);
  assert.equal(changed, true);
  assert.equal(fields.line_items[1].account_code, '371');
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

// 8. Deterministic vehicle-cost accounts receive defaults, while ambiguous
//    accounts still require an explicit category.
{
  assert.equal(defaultVehicleCostCategoryForAccount('624'), 'TRANSPORT');
  assert.equal(defaultVehicleCostCategoryForAccount('624.01'), 'TRANSPORT');
  assert.equal(defaultVehicleCostCategoryForAccount('611'), 'REFURB');
  assert.equal(defaultVehicleCostCategoryForAccount('6024'), 'REFURB');
  assert.equal(defaultVehicleCostCategoryForAccount('628'), undefined);

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
  assert.deepEqual(reviewErrors('611'), []);
  assert.deepEqual(reviewErrors('6024'), []);
  assert.deepEqual(reviewErrors('628'), [
    'Selectează categoria de cost pentru linia 1',
  ]);
  assert.deepEqual(reviewErrors('624', undefined, false), []);
  assert.deepEqual(reviewErrors('624', 'OTHER', false), []);
  assert.deepEqual(reviewErrors('628', 'ITP', false), [
    'Confirmă categoriile de cost înainte de aprobare',
  ]);
}

// 9. Posting normalization enforces the full-VIN article even if extraction or
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

console.log('vehicle-purchase-line.spec.ts passed');
