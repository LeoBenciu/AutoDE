import PDFDocument = require('pdfkit');
import {
  ContractTemplateData,
  substituteTemplateLine,
  templateValues,
} from './contract-templates';

const REGULAR_FONT = require.resolve(
  'dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
);
const BOLD_FONT = require.resolve(
  'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf',
);

const FONT_REGULAR = 'ContractRegular';
const FONT_BOLD = 'ContractBold';
const PAGE_BOTTOM_GAP = 24;

export function renderContractPdf(
  template: string,
  data: ContractTemplateData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, right: 54, bottom: 54, left: 54 },
      bufferPages: true,
      info: {
        Title: `${data.contractNumber} - ${data.vehicle.make} ${data.vehicle.model}`,
        Author: data.seller.name,
        Creator: 'AutoImport',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont(FONT_REGULAR, REGULAR_FONT);
    doc.registerFont(FONT_BOLD, BOLD_FONT);
    doc.font(FONT_REGULAR).fontSize(9.4).fillColor('#172033');

    const values = templateValues(data);
    for (const rawLine of template.replace(/\r\n/g, '\n').split('\n')) {
      doc.x = doc.page.margins.left;
      const trimmed = rawLine.trim();
      const block = trimmed.match(
        /^{{\s*(vehicle_details|signature_block|page_break)\s*}}$/,
      )?.[1];
      if (block === 'vehicle_details') {
        renderVehicleDetails(doc, data);
      } else if (block === 'signature_block') {
        renderSignatureBlock(doc, data);
      } else if (block === 'page_break') {
        doc.addPage();
      } else if (trimmed === '') {
        doc.moveDown(0.28);
      } else if (trimmed === '---') {
        ensureSpace(doc, 18);
        const y = doc.y + 5;
        doc
          .strokeColor('#CBD5E1')
          .lineWidth(0.7)
          .moveTo(doc.page.margins.left, y)
          .lineTo(doc.page.width - doc.page.margins.right, y)
          .stroke();
        doc.y = y + 9;
      } else if (trimmed.startsWith('# ')) {
        renderTitle(doc, substituteTemplateLine(trimmed.slice(2), values));
      } else if (trimmed.startsWith('## ')) {
        renderSectionHeading(
          doc,
          substituteTemplateLine(trimmed.slice(3), values),
        );
      } else if (trimmed.startsWith('> ')) {
        ensureSpace(doc, 20);
        doc
          .font(FONT_REGULAR)
          .fontSize(9.4)
          .fillColor('#334155')
          .text(substituteTemplateLine(trimmed.slice(2), values), {
            align: 'center',
            lineGap: 1.5,
          });
      } else if (/^[-*]\s+/.test(trimmed)) {
        renderBullet(
          doc,
          substituteTemplateLine(trimmed.replace(/^[-*]\s+/, ''), values),
        );
      } else {
        ensureSpace(doc, 24);
        doc
          .font(FONT_REGULAR)
          .fontSize(9.4)
          .fillColor('#172033')
          .text(substituteTemplateLine(rawLine, values), {
            align: 'left',
            lineGap: 2.2,
          });
      }
    }

    addPageNumbers(doc);
    doc.end();
  });
}

function renderTitle(doc: InstanceType<typeof PDFDocument>, title: string) {
  ensureSpace(doc, 44);
  doc.font(FONT_BOLD);
  const desiredSize = 15;
  const availableWidth = contentWidth(doc) - 8;
  const measuredWidth = doc.fontSize(desiredSize).widthOfString(title);
  const fittedSize = Math.max(
    11.5,
    Math.min(desiredSize, (desiredSize * availableWidth) / measuredWidth),
  );
  doc
    .fontSize(fittedSize)
    .fillColor('#0F172A')
    .text(title, { align: 'center', lineGap: 2 });
  doc.moveDown(0.3);
}

function renderSectionHeading(
  doc: InstanceType<typeof PDFDocument>,
  title: string,
) {
  ensureSpace(doc, 34);
  doc.moveDown(0.2);
  doc
    .font(FONT_BOLD)
    .fontSize(10)
    .fillColor('#0F172A')
    .text(title, { lineGap: 1.5 });
  const y = doc.y + 1;
  doc
    .strokeColor('#CBD5E1')
    .lineWidth(0.55)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke();
  doc.y = y + 4;
}

function renderBullet(doc: InstanceType<typeof PDFDocument>, text: string) {
  ensureSpace(doc, 22);
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  doc.font(FONT_BOLD).fontSize(9.4).text('•', x + 4, doc.y, { width: 12 });
  doc
    .font(FONT_REGULAR)
    .text(text, x + 18, doc.y - doc.currentLineHeight(), {
      width: width - 18,
      lineGap: 2,
    });
}

function renderVehicleDetails(
  doc: InstanceType<typeof PDFDocument>,
  data: ContractTemplateData,
) {
  const vehicle = data.vehicle;
  const rows: Array<[string, string]> = [
    ['Marcă / model', `${vehicle.make} ${vehicle.model} ${vehicle.variant ?? ''}`.trim()],
    ['Serie șasiu (VIN)', vehicle.vin],
    ['An fabricație', vehicle.year == null ? '-' : String(vehicle.year)],
    ['Prima înmatriculare', vehicle.firstRegistered || '-'],
    [
      'Kilometraj',
      vehicle.mileageKm == null
        ? '-'
        : `${vehicle.mileageKm.toLocaleString('ro-RO')} km`,
    ],
    ['Culoare', vehicle.color || '-'],
  ];
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const labelWidth = 145;

  ensureSpace(doc, 28);
  for (const [index, [label, value]] of rows.entries()) {
    const valueHeight = doc
      .font(FONT_REGULAR)
      .fontSize(9.2)
      .heightOfString(value, { width: width - labelWidth - 18, lineGap: 1 });
    const rowHeight = Math.max(21, valueHeight + 8);
    ensureSpace(doc, rowHeight);
    const y = doc.y;
    if (index % 2 === 0) {
      doc
        .save()
        .fillColor('#F4F7FA')
        .roundedRect(x, y, width, rowHeight, 2)
        .fill()
        .restore();
    }
    doc
      .font(FONT_BOLD)
      .fontSize(9.1)
      .fillColor('#334155')
      .text(label, x + 8, y + 5, { width: labelWidth - 12 });
    doc
      .font(FONT_REGULAR)
      .fontSize(9.2)
      .fillColor('#172033')
      .text(value, x + labelWidth, y + 5, {
        width: width - labelWidth - 8,
        lineGap: 1,
      });
    doc.y = y + rowHeight;
  }
  doc.moveDown(0.3);
}

function renderSignatureBlock(
  doc: InstanceType<typeof PDFDocument>,
  data: ContractTemplateData,
) {
  ensureSpace(doc, 82);
  doc.moveDown(0.35);
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const gap = 34;
  const columnWidth = (width - gap) / 2;
  const y = doc.y;

  signatureColumn(doc, x, y, columnWidth, 'VÂNZĂTOR', data.seller.name);
  signatureColumn(
    doc,
    x + columnWidth + gap,
    y,
    columnWidth,
    'CUMPĂRĂTOR',
    data.buyer.name,
  );
  doc.y = y + 76;
}

function signatureColumn(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  width: number,
  role: string,
  name: string,
) {
  doc
    .font(FONT_BOLD)
    .fontSize(9.5)
    .fillColor('#0F172A')
    .text(role, x, y, { width });
  doc
    .font(FONT_REGULAR)
    .fontSize(9.2)
    .text(name, x, y + 18, { width, height: 30 });
  doc
    .strokeColor('#64748B')
    .lineWidth(0.7)
    .moveTo(x, y + 56)
    .lineTo(x + Math.min(width, 190), y + 56)
    .stroke();
  doc
    .font(FONT_REGULAR)
    .fontSize(8)
    .fillColor('#64748B')
    .text('Semnătură', x, y + 61, { width });
}

function ensureSpace(doc: InstanceType<typeof PDFDocument>, needed: number) {
  const bottom = doc.page.height - doc.page.margins.bottom - PAGE_BOTTOM_GAP;
  if (doc.y + needed > bottom) doc.addPage();
}

function contentWidth(doc: InstanceType<typeof PDFDocument>) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function addPageNumbers(doc: InstanceType<typeof PDFDocument>) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc
      .font(FONT_REGULAR)
      .fontSize(7.5)
      .fillColor('#64748B')
      .text(
        `Pagina ${index + 1} din ${range.count}`,
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom - 20,
        { width: contentWidth(doc), align: 'center', lineBreak: false },
      );
  }
}
