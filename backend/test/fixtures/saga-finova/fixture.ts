import {
  SagaArticleRecord,
  SagaCompany,
  SagaMovement,
  SagaPartnerRecord,
} from '../../../src/saga/saga-xml';

export const finovaCommit = 'ed54686382e94d1ed86718a90f6289bab2f05e62';

export const company: SagaCompany = {
  cui: '50675950',
  isVatPayer: true,
  hasTvaLaIncasare: true,
};

export const rawInvoices = [
  {
    id: 101,
    type: 'Receipt',
    fields: {
      document_type: 'Receipt',
      direction: 'incoming',
      vendor: 'Furnizor & Fii SRL',
      vendor_ein: '12345678',
      vendor_reg_com: 'J40/1/2020',
      vendor_capital: '200 LEI',
      vendor_country: 'RO',
      vendor_city: 'București',
      vendor_county: 'B',
      vendor_address: 'Str. Test <1>',
      vendor_phone: '+40 700 000 000',
      vendor_email: 'office@example.test',
      vendor_bank: 'Banca Test',
      vendor_iban: 'RO49AAAA1B31007593840000',
      vendor_additional_info: 'furnizor recurent',
      guid_client_code: 'GUID-CLIENT',
      buyer: 'AutoImport Test SRL',
      buyer_ein: '50675950',
      buyer_reg_com: 'J40/2/2024',
      buyer_country: 'RO',
      buyer_county: 'B',
      buyer_city: 'București',
      buyer_address: 'Bd. Unirii 1',
      buyer_bank: 'Banca Auto',
      buyer_iban: 'RO09BBBB1B31007593840001',
      buyer_phone: '+40 700 000 001',
      buyer_email: 'contabilitate@auto.test',
      document_number: 'BON-101',
      document_date: '2026-07-15',
      due_date: '2026-07-30',
      reverse_charge: false,
      receipt_type: 'independent_receipt',
      additional_info: 'Bon fiscal "test"',
      currency: 'RON',
      weight: '',
      excise: '',
      spv_receipt_id: '',
      spv_upload_id: '',
      client_code: '',
      supplier_code: 'FURN-01',
      total_amount: 24.99,
      net_amount: 21,
      vat_amount: 3.99,
      line_items: [
        {
          name: 'Piesă & montaj',
          quantity: '2.0000',
          unit_price: '10.5000',
          line_total: '21.00',
          vat_amount: '3.99',
          vat: 'NINETEEN',
          um: 'BUCATA',
          account_code: '3024',
          articleCode: 'ART-01',
          management: '0001',
          activity: 'SERVICE',
          selectedArticleAnalitic: '',
          vat_deductibility: 'PARTIAL_50',
        },
      ],
    },
  },
] as const;

export const articles: SagaArticleRecord[] = [
  {
    code: 'ART-01',
    name: 'Piesă & montaj',
    analyticCode: '00001',
    vatRate: 'NINETEEN',
    unit: 'BUCATA',
    type: 'PIESE_DE_SCHIMB',
  },
];

export const receipts: SagaMovement[] = [
  {
    date: '2026-07-16',
    reference: 'DI&1',
    amount: 125.5,
    accountCode: '5311',
    counterAccount: '411.00001',
    description: 'Încasare avans <client>',
    currency: 'RON',
    sourceType: 'COLLECTION_DISPOSITION',
  },
];

export const payments: SagaMovement[] = [
  {
    date: '2026-07-17',
    reference: 'CH-1',
    amount: 30,
    accountCode: '5121',
    counterAccount: '401.00001',
    description: 'Plată factură & transport',
    currency: 'EUR',
    sourceType: 'RECEIPT_IN',
    documentId: 101,
    invoiceNumber: 'INV-101',
  },
];

export const suppliers: SagaPartnerRecord[] = [
  {
    name: 'Furnizor & Fii SRL',
    taxId: '12345678',
    country: 'RO',
    city: 'București',
    address: 'Str. Test <1>',
    iban: 'RO49AAAA1B31007593840000',
    bankName: 'Banca Test',
    phone: '+40 700 000 000',
    email: 'office@example.test',
    code: 'FURN-01',
    analytic: '00001',
  },
];

export const clients: SagaPartnerRecord[] = [
  {
    name: 'Client "Golden" SRL',
    taxId: '87654321',
    registration: 'J40/3/2025',
    country: 'RO',
    county: 'B',
    city: 'București',
    address: 'Calea Victoriei 1',
    iban: 'RO09CCCC1B31007593840002',
    bankName: 'Banca Client',
    phone: '+40 700 000 002',
    email: 'client@example.test',
    discount: '2',
    code: 'CLI-01',
    analytic: '00002',
  },
];
