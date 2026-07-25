/**
 * Independent, deliberately small port of the six SAGA formatters from
 * Finova ExportsPage.tsx at the commit recorded by the golden fixture.
 *
 * Keep this reference implementation stable. Production code lives in
 * src/saga/saga-xml.ts; parity tests compare both implementations with
 * committed byte-for-byte golden files.
 */

const VAT: Record<string, string> = {
  ZERO: '0',
  ONE: '1',
  FIVE: '5',
  NINE: '9',
  ELEVEN: '11',
  NINETEEN: '19',
  TWENTYONE: '21',
  TWENTY_FOUR: '24',
};

const UNITS: Record<string, string> = {
  BUCATA: 'BUC',
  KILOGRAM: 'KG',
  LITRU: 'LITRI',
  METRU: 'M',
  GRAM: 'GRAME',
  CUTIE: 'CUTII',
  PACHET: 'PAC',
  PUNGA: 'PUNGI',
  SET: 'SET',
  METRU_PATRAT: 'MP',
  METRU_CUB: 'MC',
  MILIMETRU: 'MM',
  CENTIMETRU: 'CM',
  TONA: 'TONE',
  PERECHE: 'PER',
  SAC: 'SACI',
  MILILITRU: 'ML',
  KILOWATT_ORA: 'KWH',
  MINUT: 'MIN',
  ORA: 'ORE',
  ZI_DE_LUCRU: 'ZILE',
  LUNI_DE_LUCRU: 'LUNI',
  DOZA: 'DOZE',
  UNITATE_DE_SERVICE: 'SERV',
  O_MIE_DE_BUCATI: '1000B',
  TRIMESTRU: 'TRIM',
  PROCENT: 'PROC',
  KILOMETRU: 'KM',
  LADA: 'LADA',
  DRY_TONE: 'DT',
  CENTIMETRU_PATRAT: 'CMP',
  MEGAWATI_ORA: 'MWH',
  ROLA: 'ROLA',
  TAMBUR: 'TAMB',
  SAC_PLASTIC: 'SAC',
  PALET_LEMN: 'PALET',
  UNITATE: 'UNIT',
  TONA_NETA: 'TN',
  HECTOMETRU_PATRAT: 'HA',
  FOAIE: 'FOAIE',
};

const ARTICLE_TYPES: Record<string, string> = {
  MARFURI: '01',
  MATERII_PRIME: '02',
  MATERIALE_AUXILIARE: '03',
  PRODUSE_FINITE: '04',
  AMBALAJE: '05',
  OBIECTE_DE_INVENTAR: '06',
  PRODUSE_REZIDUALE: '07',
  SEMIFABRICATE: '08',
  AMENAJARI_PROVIZORII: '09',
  MAT_SPRE_LUCRARE: '10',
  MAT_IN_PASTRARE_CONSIG: '11',
  DISCOUNT_FINANCIAR_INTRARI: '12',
  DISCOUNT_FINANCIAR_IESIRI: '13',
  COMBUSTIBILI: '14',
  PIESE_DE_SCHIMB: '15',
  ALTE_MAT_CONSUMABILE: '16',
  SERVICII_VANDUTE: '17',
  DISCOUNT_COMERCIAL_INTRARI: '18',
  DISCOUNT_COMERCIAL_IESIRI: '19',
  AMBALAJE_SGR: 'GR',
  TAXA_VERDE: 'TV',
};

export function finovaFacturi(
  invoices: readonly any[],
  company: { hasTvaLaIncasare: boolean; isVatPayer: boolean },
  articles: readonly any[],
): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Facturi>\n';
  for (const invoice of invoices) {
    const data = invoice.fields;
    xml += '  <Factura>\n    <Antet>\n';
    const header: Array<[string, unknown]> = [
      ['FurnizorNume', data.vendor],
      ['FurnizorCIF', data.vendor_ein],
      ['FurnizorNrRegCom', data.vendor_reg_com],
      ['FurnizorCapital', data.vendor_capital],
      ['FurnizorTara', data.vendor_country || 'RO'],
      ['FurnizorLocalitate', data.vendor_city],
      ['FurnizorJudet', data.vendor_county],
      ['FurnizorAdresa', data.vendor_address],
      ['FurnizorTelefon', data.vendor_phone],
      ['FurnizorMail', data.vendor_email],
      ['FurnizorBanca', data.vendor_bank],
      ['FurnizorIBAN', data.vendor_iban],
      ['FurnizorInformatiiSuplimentare', data.vendor_additional_info],
      ['GUID_cod_client', data.guid_client_code],
      ['ClientNume', data.buyer],
      ['ClientInformatiiSuplimentare', data.buyer_additional_info],
      ['ClientCIF', data.buyer_ein],
      ['ClientNrRegCom', data.buyer_reg_com],
      ['ClientJudet', data.buyer_county],
      ['ClientTara', data.buyer_country || 'RO'],
      ['ClientLocalitate', data.buyer_city],
      ['ClientAdresa', data.buyer_address],
      ['ClientBanca', data.buyer_bank],
      ['ClientIBAN', data.buyer_iban],
      ['ClientTelefon', data.buyer_phone],
      ['ClientMail', data.buyer_email],
      ['FacturaNumar', data.document_number],
      ['FacturaData', date(data.document_date)],
      ['FacturaScadenta', date(data.due_date)],
      ['FacturaTaxareInversa', data.reverse_charge ? 'Da' : 'Nu'],
      ['FacturaTVAIncasare', company.hasTvaLaIncasare ? 'Da' : 'Nu'],
      [
        'FacturaTip',
        invoice.type === 'Receipt' || data.receipt_type === 'independent_receipt'
          ? 'C'
          : '',
      ],
      ['FacturaInformatiiSuplimentare', data.additional_info],
      ['FacturaMoneda', data.currency || 'RON'],
      ['FacturaGreutate', data.weight],
      ['FacturaAccize', data.excise],
      ['FacturaIndexSPV', data.spv_receipt_id],
      ['FacturaIndexDescarcareSPV', data.spv_upload_id],
      ['Cod', data.client_code || data.supplier_code],
    ];
    for (const [name, value] of header) {
      xml += `      <${name}>${escape(value)}</${name}>\n`;
    }
    xml += '    </Antet>\n    <Detalii>\n      <Continut>\n';
    for (const [index, item] of (data.line_items ?? []).entries()) {
      const rawVat = scalar(item.vat_rate || item.vat || item.proc_tva || 'NINETEEN')
        .trim()
        .toUpperCase();
      const vat = VAT[rawVat] ?? (/^\d+$/.test(rawVat) ? rawVat : '19');
      const rawUnit = scalar(item.um || item.unitOfMeasure || '').trim().toUpperCase();
      const unit = UNITS[rawUnit] ?? rawUnit;
      const article = articles.find(
        (candidate) =>
          candidate.code === item.articleCode ||
          String(candidate.code) === String(item.articleCode) ||
          candidate.code === String(item.articleCode).toUpperCase(),
      );
      const analytic =
        article?.analitic || item.selectedArticleAnalitic || item.analitic || '';
      const net = Number(item.line_total || item.total || item.valoare || 0) || 0;
      const vatAmount = Number(item.vat_amount || item.tva || 0) || 0;
      const quantity = Number(item.quantity ?? 1) || 0;
      const gross = (net + vatAmount).toFixed(2);
      const value = company.isVatPayer
        ? item.line_total || item.total || item.valoare || '0'
        : gross;
      const price = company.isVatPayer
        ? item.unit_price || item.pret || '0'
        : quantity
          ? (Number(gross) / quantity).toFixed(4)
          : (Number(item.unit_price || item.pret || 0) + vatAmount).toFixed(4);
      const deduction =
        item.vat_deductibility === 'PARTIAL_50'
          ? 'N50'
          : item.vat_deductibility === 'NONE'
            ? 'I'
            : '';
      xml += `        <Linie>
          <LinieNrCrt>${index + 1}</LinieNrCrt>
          <Gestiune>${escape(
            typeof item.management === 'object' ? '' : item.management || item.gestiune,
          )}</Gestiune>
          <Activitate>${escape(item.activity || item.activitate)}</Activitate>
          <Descriere>${escape(item.description || item.name)}</Descriere>
          <CodArticolFurnizor>${escape(analytic)}</CodArticolFurnizor>
          <CodArticolClient>${escape(analytic)}</CodArticolClient>
          <GUID_cod_articol>${escape(item.guid_article_code || item.guid_cod_articol)}</GUID_cod_articol>
          <CodBare>${escape(item.barcode || item.cod_bare)}</CodBare>
          <InformatiiSuplimentare>${escape(item.additional_info || item.informatii_suplimentare)}</InformatiiSuplimentare>
          <UM>${escape(unit)}</UM>
          <Cantitate>${escape(item.quantity || '1')}</Cantitate>
          <Pret>${escape(price)}</Pret>
          <Valoare>${escape(value)}</Valoare>
          <ProcTVA>${company.isVatPayer ? escape(vat) : ''}</ProcTVA>
          <TVA>${company.isVatPayer ? escape(item.vat_amount || item.tva || '0') : ''}</TVA>
          <Cont>${escape(item.account_code || item.cont)}</Cont>
          <TipDeducere>${deduction}</TipDeducere>
          <PretVanzare></PretVanzare>
        </Linie>
`;
    }
    xml += `      </Continut>
    </Detalii>
    <FacturaID>${escape(invoice.id)}</FacturaID>
  </Factura>
`;
  }
  xml += '</Facturi>';
  return xml;
}

export function finovaMovements(
  root: 'Incasari' | 'Plati',
  movements: readonly any[],
): string {
  const counterTag = root === 'Incasari' ? 'ContClient' : 'ContFurnizor';
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n`;
  for (const item of movements) {
    const disposition =
      item.sourceType ===
      (root === 'Incasari' ? 'COLLECTION_DISPOSITION' : 'PAYMENT_DISPOSITION');
    xml += `  <Linie>
    <Data>${date(item.date || item.transactionDate)}</Data>
    <Numar>${escape(item.reference || item.referenceNumber || item.document_number)}</Numar>
    <Suma>${escape(String(Math.abs(item.amount || item.total_amount || 0)))}</Suma>
    <Cont>${escape(disposition && String(item.accountCode).startsWith('5311') ? '5311' : item.accountCode || item.cont || '5121')}</Cont>
    <${counterTag}>${escape(root === 'Incasari' ? item.clientAccount || item.cont_client : item.supplierAccount || item.cont_furnizor)}</${counterTag}>
    <Explicatie>${escape(item.description || item.explanation || item.explicatie)}</Explicatie>
    <FacturaID>${disposition ? '' : escape(item.documentId || item.factura_id)}</FacturaID>
    <FacturaNumar>${disposition ? '' : escape(item.invoiceNumber || item.factura_numar)}</FacturaNumar>
    <CodFiscal></CodFiscal>
    <Moneda>${escape(item.currency || item.moneda || 'RON')}</Moneda>
  </Linie>
`;
  }
  xml += `</${root}>`;
  return xml;
}

export function finovaPartners(
  root: 'Furnizori' | 'Clienti',
  partners: readonly any[],
): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n`;
  for (const partner of partners) {
    const rows: Array<[string, unknown]> = [
      ['Cod', partner.analitic],
      ['Denumire', partner.name],
      ['Cod_fiscal', partner.ein],
      ...(root === 'Clienti' ? ([['Reg_com', partner.regCom]] as Array<[string, unknown]>) : []),
      ['Tara', partner.tara || 'RO'],
      ...(root === 'Clienti' ? ([['Judet', partner.judet]] as Array<[string, unknown]>) : []),
      ['Localitate', partner.localitate],
      ['Adresa', partner.address],
      ['Cont_banca', partner.contBancar],
      ['Banca', partner.banca],
      ['Tel', partner.phone],
      ['Email', partner.email],
      ...(root === 'Clienti' ? ([['Discount', partner.discount]] as Array<[string, unknown]>) : []),
      ['Informatii', ''],
      ['Guid_cod', partner.code],
    ];
    xml += '  <Linie>\n';
    for (const [name, value] of rows) {
      xml += `    <${name}>${escape(value)}</${name}>\n`;
    }
    xml += '  </Linie>\n';
  }
  xml += `</${root}>`;
  return xml;
}

export function finovaArticles(articles: readonly any[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Articole>\n';
  for (const article of articles.filter((candidate) => candidate.analitic)) {
    const rawVat = scalar(article.vat).trim().toUpperCase();
    const vat = VAT[rawVat] ?? (/^\d+$/.test(rawVat) ? rawVat : '');
    const rawUnit = scalar(article.unitOfMeasure || article.um).trim().toUpperCase();
    const unit = UNITS[rawUnit] ?? rawUnit;
    xml += `  <Linie>
    <Cod>${escape(article.analitic)}</Cod>
    <Denumire>${escape(article.name)}</Denumire>
    <Cod_NC></Cod_NC>
    <Cod_CPV></Cod_CPV>
    <UM>${escape(unit)}</UM>
    <Tip>${escape(ARTICLE_TYPES[article.type] || article.type)}</Tip>
    <TVA>${escape(vat)}</TVA>
    <Pret></Pret>
    <Pret_TVA></Pret_TVA>
    <Cod_bare></Cod_bare>
    <Informatii></Informatii>
    <Guid_cod>${escape(article.code)}</Guid_cod>
  </Linie>
`;
  }
  xml += '</Articole>';
  return xml;
}

function date(value: unknown): string {
  if (!value) return '';
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function escape(value: unknown): string {
  return scalar(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function scalar(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return String(object.name ?? object.code ?? object.id ?? '');
  }
  return String(value);
}
