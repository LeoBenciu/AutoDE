import { expect, Page, test } from '@playwright/test';

const email = 'ui-acceptance@autoimport.test';
const password = 'UiAcceptance!2026';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('@desktop core flows and side-by-side extraction review', async ({
  page,
}, testInfo) => {
  await expect(page.getByRole('heading', { name: /Bună, Ana/ })).toBeVisible();
  await expect(page.getByText('Situația documentelor')).toBeVisible();
  await expect(page.getByText(/în tranzit fără cod UIT confirmat/)).toBeVisible();

  await page.goto('/vehicule');
  await expect(page.getByText('Golf Acceptance')).toBeVisible();
  await page.getByText('Golf Acceptance').click();
  await expect(
    page.getByRole('heading', { name: 'Volkswagen Golf Acceptance' }),
  ).toBeVisible();
  await expect(page.getByText(/CV-UI-00001 · vanzare-cumparare/)).toBeVisible();
  const contractPopupPromise = page.waitForEvent('popup');
  const contractPdfRequestPromise = page.context().waitForEvent('request', {
    predicate: (request) => request.url().includes('ui-acceptance.pdf'),
  });
  await page
    .getByRole('button', {
      name: /Deschide contractul CV-UI-00001 într-o filă nouă/,
    })
    .click();
  const contractPopup = await contractPopupPromise;
  const contractPdfRequest = await contractPdfRequestPromise;
  expect(contractPdfRequest.url()).toContain('ui-acceptance.pdf');
  await contractPopup.close();

  await page.goto('/documente');
  await expect(page.locator('select option[value="Contract"]')).toHaveCount(1);
  await expect(page.locator('select option[value="Customs Declaration"]')).toHaveCount(0);
  await expect(page.locator('select option[value="Technical Inspection (ITP)"]')).toHaveCount(0);
  await expect(page.locator('select option[value="Insurance"]')).toHaveCount(0);
  await page.getByPlaceholder('Caută după nume, tip, VIN, client…').fill('UI Acceptance');
  await expect(page.getByText('UI Acceptance Invoice.pdf')).toBeVisible();
  await page.getByText('UI Acceptance Invoice.pdf').first().click();

  const dialog = page.getByRole('dialog', {
    name: /Date extrase pentru UI Acceptance Invoice/,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('PDF · pagina 1')).toBeVisible();
  await expect(
    dialog.getByText('Furnizor Acceptance SRL', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText('Servicii acceptanță', { exact: true }).first(),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Aprobă și postează/ })).toBeEnabled();

  const preview = dialog.locator('iframe');
  const details = dialog.getByText('Furnizor Acceptance SRL', { exact: true });
  await expect(preview).toBeVisible();
  expect(await preview.getAttribute('src')).toContain('ui-acceptance.pdf');
  const previewBox = await preview.boundingBox();
  const detailsBox = await details.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(detailsBox).not.toBeNull();
  expect(previewBox!.x).toBeLessThan(detailsBox!.x);

  await page.screenshot({
    path: testInfo.outputPath('document-review-desktop.png'),
    fullPage: false,
  });

  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Deschide separat' }).click();
  const documentPopup = await popupPromise;
  await documentPopup.close();

  await dialog.getByRole('button', { name: 'Arhivează' }).click();
  const documentRow = page
    .locator('button')
    .filter({ hasText: 'UI Acceptance Invoice.pdf' });
  await expect(documentRow).toHaveCount(0);
  await page.getByLabel('Arhivate').check();
  await expect(documentRow).toBeVisible();
  await documentRow.click();
  const archivedDialog = page.getByRole('dialog', {
    name: /Date extrase pentru UI Acceptance Invoice/,
  });
  await archivedDialog.getByRole('button', { name: 'Restaurează' }).click();
  await expect(documentRow).toHaveCount(0);

  await page.getByLabel('Arhivate').uncheck();
  await expect(documentRow).toBeVisible();
  await page.getByPlaceholder('Caută după nume, tip, VIN, client…').fill('');
  const uploadInput = page.locator('input[type="file"]').first();
  await uploadInput.setInputFiles({
    name: 'ui-upload-acceptance.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  const pendingUpload = page.getByText('ui-upload-acceptance.png');
  await expect(pendingUpload).toBeVisible();
  await pendingUpload
    .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]')
    .getByRole('button', { name: 'Anulează' })
    .click();
  await expect(pendingUpload).not.toBeVisible();

  await page.goto('/e-transport');
  await expect(page.getByText('B123UIT')).toBeVisible();

  await page.goto('/exporturi');
  const quickExport = page.getByRole('button', {
    name: 'Re-exportă ultima configurație',
  });
  await expect(quickExport).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await quickExport.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^SAGA_Export_\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByText(/re-generat folosind ultima configurație/)).toBeVisible();
});

test('@desktop document review hides internal extraction metadata', async ({
  page,
}) => {
  await page.goto('/documente');
  await page.getByText('UI Acceptance Invoice.pdf').first().click();

  const dialog = page.getByRole('dialog', {
    name: /Date extrase pentru UI Acceptance Invoice/,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('internal-document-hash-must-not-render');
});

test('@desktop contract templates are editable and preview as PDF', async ({
  page,
}) => {
  await page.goto('/setari');
  await page.getByRole('button', { name: 'Contracte PDF' }).click();
  await expect(
    page.getByRole('heading', { name: 'Alege documentul' }),
  ).toBeVisible();

  const saleTemplate = page.getByLabel('Șablon contract vânzare');
  await expect(saleTemplate).toHaveValue(/CONTRACT DE VÂNZARE-CUMPĂRARE AUTO/);
  await page.getByRole('button', { name: 'Vehicul', exact: true }).click();
  await expect(page.getByRole('button', { name: /Serie șasiu/ })).toBeVisible();
  await saleTemplate.fill(
    '# CONTRACT PERSONALIZAT ȘȚĂÎÂ\n> Nr. {{contract_number}} din {{contract_date}}\n\n{{vehicle_details}}\n\n{{signature_block}}',
  );
  await expect(page.getByText('1 document nesalvat')).toBeVisible();
  await expect(page.getByText('Șablon gata de generare')).toBeVisible();
  await page.getByRole('button', { name: 'Previzualizează PDF' }).click();
  await expect(page.getByTitle('Previzualizare șablon PDF')).toHaveAttribute(
    'src',
    /^blob:/,
  );

  await page.getByRole('button', { name: 'Proces-verbal' }).click();
  await expect(page.getByLabel('Șablon proces-verbal')).toHaveValue(
    /PROCES-VERBAL DE PREDARE-PRIMIRE AUTOVEHICUL/,
  );
});

test('@mobile contract customizer remains usable without horizontal overflow', async ({
  page,
}) => {
  await page.goto('/setari');
  await page.getByRole('button', { name: 'Contracte PDF' }).click();

  await expect(page.getByRole('heading', { name: 'Alege documentul' })).toBeVisible();
  await expect(page.getByLabel('Șablon contract vânzare')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salvează modificările' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    )
    .toBe(true);
});

test('@mobile 360 layout keeps document and extracted data usable', async ({
  page,
}, testInfo) => {
  await page.goto('/documente');
  await expect(page.getByRole('heading', { name: 'Documente' })).toBeVisible();
  await page.getByText('UI Acceptance Invoice.pdf').first().click();

  const dialog = page.getByRole('dialog', {
    name: /Date extrase pentru UI Acceptance Invoice/,
  });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(360);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  await expect(dialog.getByText('PDF · pagina 1')).toBeVisible();
  await expect(
    dialog.getByText('Furnizor Acceptance SRL', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Aprobă și postează/ })).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath('document-review-mobile-360.png'),
    fullPage: false,
  });
});

test('@desktop vehicle selectors constrain model and retain brand logo', async ({
  page,
}, testInfo) => {
  await page.goto('/vehicule');
  await expect(page.getByLabel('Sigla Volkswagen')).toBeVisible();
  await page.getByRole('button', { name: 'Adaugă' }).click();

  const sellerMode = page.getByRole('combobox', {
    name: 'Mod selectare vânzător inițial',
  });
  await sellerMode.selectOption('new');
  await expect(page.getByRole('combobox', { name: 'Tip vânzător' })).toHaveValue(
    'INDIVIDUAL',
  );
  await expect(page.getByRole('textbox', { name: 'CNP vânzător' })).toBeVisible();
  await sellerMode.selectOption('none');

  const brand = page.getByRole('combobox', { name: 'Marcă' });
  const model = page.getByRole('combobox', { name: 'Model' });
  await expect(model).toBeDisabled();
  await brand.click();
  await expect(page.getByRole('option', { name: /Abarth/ })).toBeVisible();
  await page.getByRole('option', { name: /Zeekr/ }).click();
  await expect(page.getByRole('textbox', { name: 'Model', exact: true })).toBeEnabled();
  await brand.click();
  await page.getByRole('option', { name: /Volvo/ }).click();
  await expect(model).toBeEnabled();
  await expect(model.locator('option')).toContainText(['V40', 'XC60', 'XC90']);
  await page.screenshot({
    path: testInfo.outputPath('vehicle-brand-model-selectors.png'),
    fullPage: false,
  });

  await page.getByPlaceholder('VIN (17 caractere)').fill('YV1MV70V1K2549984');
  await model.selectOption('V40');
  await page.getByPlaceholder('An fabricație').fill('2019');
  await page.getByPlaceholder('Kilometraj').fill('125000');
  await page.getByPlaceholder('Preț achiziție').fill('10499');
  await page.getByRole('combobox', { name: 'Țara de origine' }).selectOption('SE');
  await page.getByRole('button', { name: 'Salvează' }).click();

  const createdCard = page.getByRole('link', { name: /Volvo V40/ });
  await expect(createdCard).toBeVisible();
  await expect(createdCard.getByLabel('Sigla Volvo')).toBeVisible();
  await expect(createdCard).toContainText('SE');
  await page.screenshot({
    path: testInfo.outputPath('vehicle-card-with-brand-logo.png'),
    fullPage: false,
  });
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Parolă').fill(password);
  await page.getByRole('button', { name: 'Autentificare' }).click();
  await expect(page.getByRole('heading', { name: /Bună, Ana/ })).toBeVisible();
}
