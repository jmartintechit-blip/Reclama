// The formal payment demand ("requerimiento de pago") as a PDF. The text of the letter is Spanish
// because it goes to Spanish debtors; the code is English. Pure apart from pdfkit: the data and
// the date of the letter come in as arguments, nothing is read from the clock, the database or
// the disk (pdfkit only loads its own standard-font data).
//
// Every number comes from the frozen claim: the amounts and the interest segments are printed as
// they were stored and are never recalculated here. Every text typed by a user passes through
// sanitizeForPdf first, because the standard Helvetica font can only draw Windows-1252.
import PDFDocument from 'pdfkit';
import { COMPENSATION_CENTS, type CompensationMode } from '../domain/claim.ts';
import { addDays, type ISODate } from '../domain/dates.ts';
import type { InterestSegment } from '../domain/interest.ts';
import { formatEUR, type Cents } from '../domain/money.ts';
import { sanitizeForPdf } from '../domain/pdf-text.ts';

// Calendar days, counted from the date of the letter, that the debtor has to pay.
export const PAYMENT_DEADLINE_DAYS = 10;

// The data cannot be turned into a letter (for example an invoice without interest segments).
export class LetterDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LetterDataError';
  }
}

export interface LetterInvoice {
  number: string;
  issueDate: ISODate;
  dueDate: ISODate; // the one the interest was calculated from
  dueDateEstimated: boolean; // true when the invoice had no due date and issue date + 30 days was used
  principal: Cents; // still owed at the claim date
  interest: Cents;
  segments: readonly InterestSegment[];
}

export interface LetterData {
  letterDate: ISODate;
  claimId: string;
  asOf: ISODate; // the date the interest was calculated up to
  compensationMode: CompensationMode;
  principal: Cents;
  interest: Cents;
  compensation: Cents;
  total: Cents;
  sender: {
    name: string;
    taxId: string;
    address: string; // may have several lines
    iban: string | null; // already validated, without spaces
  };
  debtor: { name: string; taxId: string | null };
  invoices: readonly LetterInvoice[];
}

// A4 in points.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 72;
const WIDTH = PAGE_WIDTH - 2 * MARGIN_X;
const BOTTOM = PAGE_HEIGHT - MARGIN_BOTTOM; // content never goes below this
const CELL_PAD = 4;

const COLOR = {
  text: '#1f2933',
  muted: '#667085',
  line: '#d0d5dd',
  fill: '#f2f4f7',
  accent: '#1d3557',
};
const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const ITALIC = 'Helvetica-Oblique';

const formatDate = (date: ISODate): string =>
  `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

// 1040 -> "10,40 %"
const formatRate = (rateBp: number): string =>
  `${String(Math.floor(rateBp / 100))},${String(rateBp % 100).padStart(2, '0')} %`;

// "ES9121000418450200051332" -> "ES91 2100 0418 4502 0005 1332"
const groupIban = (iban: string): string =>
  (iban.match(/.{1,4}/g) ?? []).join(' ');

const clean = (text: string): string => sanitizeForPdf(text).text.trim();

// "REQ-" and the first eight characters of the claim id.
const referenceOf = (claimId: string): string =>
  `REQ-${clean(claimId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;

interface Column {
  header: string;
  width: number;
  align: 'left' | 'right';
}

type Doc = InstanceType<typeof PDFDocument>;

function draw(doc: Doc, data: LetterData): void {
  const sender = {
    name: clean(data.sender.name),
    taxId: clean(data.sender.taxId),
    lines: data.sender.address
      .split(/\r\n|\r|\n/)
      .map(clean)
      .filter((line) => line !== ''),
    iban: data.sender.iban === null ? null : clean(data.sender.iban),
  };
  const debtorName = clean(data.debtor.name);
  const debtorTaxId =
    data.debtor.taxId === null ? '' : clean(data.debtor.taxId);
  const reference = referenceOf(data.claimId);
  const deadline = addDays(data.letterDate, PAYMENT_DEADLINE_DAYS);
  const withCompensation = data.compensationMode !== 'NONE';

  // `y` is the only cursor: every piece of text is placed at an explicit position.
  let y = MARGIN_TOP;

  const style = (font: string, size: number, color = COLOR.text) =>
    doc.font(font).fontSize(size).fillColor(color);
  const heightOf = (text: string, width: number, font: string, size: number) =>
    style(font, size).heightOfString(text, { width });
  const newPage = () => {
    doc.addPage();
    y = MARGIN_TOP;
  };
  const ensureSpace = (height: number) => {
    if (y + height > BOTTOM) newPage();
  };

  // A block of text; it moves to the next page as a whole when it does not fit.
  const paragraph = (
    text: string,
    {
      font = REGULAR,
      size = 10,
      color = COLOR.text,
      x = MARGIN_X,
      width = WIDTH,
      gap = 8,
      align = 'left',
    }: {
      font?: string;
      size?: number;
      color?: string;
      x?: number;
      width?: number;
      gap?: number;
      align?: 'left' | 'right';
    } = {},
  ) => {
    const height = heightOf(text, width, font, size);
    ensureSpace(height);
    style(font, size, color).text(text, x, y, { width, align });
    y += height + gap;
  };

  const titleHeight = (text: string) => heightOf(text, WIDTH, BOLD, 11) + 6;
  const drawTitle = (text: string) => {
    style(BOLD, 11, COLOR.accent).text(text, MARGIN_X, y, { width: WIDTH });
    y += titleHeight(text);
  };
  // A section title never ends a page: it moves along with the first `bodyHeight` of its body.
  const sectionTitle = (text: string, bodyHeight: number) => {
    ensureSpace(titleHeight(text) + bodyHeight);
    drawTitle(text);
  };

  const rowHeight = (cells: string[], columns: Column[], font: string) =>
    Math.max(
      ...cells.map((cell, i) =>
        heightOf(cell, (columns[i]?.width ?? 0) - 2 * CELL_PAD, font, 9),
      ),
    ) +
    2 * CELL_PAD;

  const drawRow = (
    cells: string[],
    columns: Column[],
    font: string,
    height: number,
    fill: string | null,
  ) => {
    if (fill !== null) {
      doc.rect(MARGIN_X, y, WIDTH, height).fill(fill);
    }
    let x = MARGIN_X;
    cells.forEach((cell, i) => {
      const column = columns[i];
      if (column === undefined) return;
      style(font, 9).text(cell, x + CELL_PAD, y + CELL_PAD, {
        width: column.width - 2 * CELL_PAD,
        align: column.align,
      });
      x += column.width;
    });
    y += height;
    doc
      .moveTo(MARGIN_X, y)
      .lineTo(MARGIN_X + WIDTH, y)
      .lineWidth(0.5)
      .strokeColor(COLOR.line)
      .stroke();
  };

  // A table whose header is repeated on every page. `heading` is drawn above it (and again, with
  // `continued` true, after a page break); the heading, the header row and the first row always
  // stay together, so a page never ends with a lone header.
  const table = (
    columns: Column[],
    rows: string[][],
    heading?: { height: number; draw: (continued: boolean) => void },
  ) => {
    const headerCells = columns.map((column) => column.header);
    const headerHeight = rowHeight(headerCells, columns, BOLD);
    const firstHeight = rows[0] ? rowHeight(rows[0], columns, REGULAR) : 0;
    const start = (continued: boolean) => {
      heading?.draw(continued);
      drawRow(headerCells, columns, BOLD, headerHeight, COLOR.fill);
    };
    ensureSpace((heading?.height ?? 0) + headerHeight + firstHeight);
    start(false);
    for (const row of rows) {
      const height = rowHeight(row, columns, REGULAR);
      if (y + height > BOTTOM) {
        newPage();
        start(true);
      }
      drawRow(row, columns, REGULAR, height, null);
    }
  };

  // ---- Sender, date and reference ----
  const senderTop = y;
  const senderWidth = 290;
  paragraph(sender.name, {
    font: BOLD,
    size: 12,
    width: senderWidth,
    gap: 2,
  });
  paragraph(`NIF/CIF: ${sender.taxId}`, { width: senderWidth, gap: 2 });
  for (const line of sender.lines) {
    paragraph(line, { width: senderWidth, gap: 0 });
  }
  const senderEnd = y;
  y = senderTop;
  const metaX = MARGIN_X + senderWidth + 20;
  const metaWidth = WIDTH - senderWidth - 20;
  paragraph('FECHA', {
    x: metaX,
    width: metaWidth,
    size: 8,
    color: COLOR.muted,
    gap: 0,
  });
  paragraph(formatDate(data.letterDate), {
    x: metaX,
    width: metaWidth,
    gap: 6,
  });
  paragraph('REFERENCIA', {
    x: metaX,
    width: metaWidth,
    size: 8,
    color: COLOR.muted,
    gap: 0,
  });
  paragraph(reference, { x: metaX, width: metaWidth, gap: 0 });
  y = Math.max(y, senderEnd) + 28;

  // ---- Recipient and title ----
  paragraph('DESTINATARIO', { size: 8, color: COLOR.muted, gap: 0 });
  paragraph(debtorName, { font: BOLD, size: 11, gap: 2 });
  if (debtorTaxId !== '') {
    paragraph(`NIF/CIF: ${debtorTaxId}`, { gap: 0 });
  }
  y += 24;
  paragraph('REQUERIMIENTO DE PAGO', {
    font: BOLD,
    size: 15,
    color: COLOR.accent,
    gap: 12,
  });

  paragraph(
    `${sender.name} (en adelante, «el acreedor») le comunica que, a fecha ${formatDate(data.asOf)}, constan impagadas y vencidas las facturas que se relacionan a continuación. En consecuencia, le requiere formalmente el pago de ${formatEUR(data.total)}, cuyo desglose figura en este documento, dentro de los ${String(PAYMENT_DEADLINE_DAYS)} días naturales siguientes a la fecha de este requerimiento, es decir, hasta el ${formatDate(deadline)} (inclusive).`,
    { gap: 14 },
  );

  // ---- Claimed invoices ----
  // The title and the note about estimated due dates are the heading of the table, so they
  // always stay with its first rows and the note never ends up alone after the last row.
  const estimatedNote = data.invoices.some(
    (invoice) => invoice.dueDateEstimated,
  )
    ? '* Sin fecha de pago pactada: se ha tomado el plazo de 30 días naturales desde la fecha de emisión de la factura (art. 4 de la Ley 3/2004).'
    : null;
  const noteHeight =
    estimatedNote === null ? 0 : heightOf(estimatedNote, WIDTH, REGULAR, 8) + 6;
  table(
    [
      { header: 'Factura', width: 173.28, align: 'left' },
      { header: 'Emisión', width: 72, align: 'left' },
      { header: 'Vencimiento', width: 88, align: 'left' },
      { header: 'Principal pendiente', width: 150, align: 'right' },
    ],
    data.invoices.map((invoice) => [
      clean(invoice.number),
      formatDate(invoice.issueDate),
      `${formatDate(invoice.dueDate)}${invoice.dueDateEstimated ? ' *' : ''}`,
      formatEUR(invoice.principal),
    ]),
    {
      height: titleHeight('Facturas reclamadas') + noteHeight,
      draw: (continued) => {
        if (continued) return;
        drawTitle('Facturas reclamadas');
        if (estimatedNote !== null) {
          paragraph(estimatedNote, { size: 8, color: COLOR.muted, gap: 6 });
        }
      },
    },
  );
  y += 14;

  // ---- Totals ----
  const totalRows: { label: string; value: string; note?: string }[] = [
    { label: 'Principal pendiente', value: formatEUR(data.principal) },
    {
      label: `Intereses de demora hasta el ${formatDate(data.asOf)}`,
      value: formatEUR(data.interest),
    },
  ];
  if (withCompensation) {
    totalRows.push({
      label: 'Indemnización por costes de cobro (art. 8)',
      value: formatEUR(data.compensation),
      note:
        data.compensationMode === 'PER_INVOICE'
          ? `Cantidad fija de ${formatEUR(COMPENSATION_CENTS)} por cada una de las ${String(data.invoices.length)} facturas vencidas.`
          : `Cantidad fija de ${formatEUR(COMPENSATION_CENTS)} por esta reclamación.`,
    });
  }
  const labelWidth = WIDTH - 130;
  const rowsHeight =
    totalRows.reduce(
      (sum, row) =>
        sum +
        2 * CELL_PAD +
        heightOf(row.label, labelWidth - 2 * CELL_PAD, REGULAR, 10) +
        (row.note === undefined
          ? 0
          : 2 + heightOf(row.note, labelWidth - 2 * CELL_PAD, REGULAR, 8)),
      0,
    ) +
    2 * CELL_PAD +
    16;
  sectionTitle('Importe reclamado', rowsHeight);
  const boxTop = y;
  for (const row of totalRows) {
    const labelHeight = heightOf(
      row.label,
      labelWidth - 2 * CELL_PAD,
      REGULAR,
      10,
    );
    style(REGULAR, 10).text(row.label, MARGIN_X + CELL_PAD, y + CELL_PAD, {
      width: labelWidth - 2 * CELL_PAD,
    });
    style(REGULAR, 10).text(row.value, MARGIN_X + labelWidth, y + CELL_PAD, {
      width: 130 - CELL_PAD,
      align: 'right',
    });
    let height = labelHeight;
    if (row.note !== undefined) {
      style(REGULAR, 8, COLOR.muted).text(
        row.note,
        MARGIN_X + CELL_PAD,
        y + CELL_PAD + labelHeight + 2,
        { width: labelWidth - 2 * CELL_PAD },
      );
      height += 2 + heightOf(row.note, labelWidth - 2 * CELL_PAD, REGULAR, 8);
    }
    y += height + 2 * CELL_PAD;
  }
  doc.rect(MARGIN_X, y, WIDTH, 16 + 2 * CELL_PAD).fill(COLOR.fill);
  style(BOLD, 11).text(
    'TOTAL RECLAMADO',
    MARGIN_X + CELL_PAD,
    y + CELL_PAD + 1,
    {
      width: labelWidth - 2 * CELL_PAD,
    },
  );
  style(BOLD, 11).text(
    formatEUR(data.total),
    MARGIN_X + labelWidth,
    y + CELL_PAD + 1,
    {
      width: 130 - CELL_PAD,
      align: 'right',
    },
  );
  y += 16 + 2 * CELL_PAD;
  doc
    .rect(MARGIN_X, boxTop, WIDTH, y - boxTop)
    .lineWidth(0.75)
    .strokeColor(COLOR.accent)
    .stroke();
  y += 8;
  paragraph(
    `Los intereses se han calculado hasta el ${formatDate(data.asOf)} y siguen devengándose hasta el pago efectivo. El cálculo de cada factura figura en el anexo.`,
    { size: 8, color: COLOR.muted, gap: 14 },
  );

  // ---- How to pay ----
  const payment =
    `El pago debe efectuarse como máximo el ${formatDate(deadline)}. ` +
    (sender.iban === null
      ? `Para concretar la forma de pago, póngase en contacto con el acreedor indicando la referencia ${reference}.`
      : `Puede hacerlo mediante transferencia bancaria a la cuenta ${groupIban(sender.iban)}, a nombre de ${sender.name}, indicando como concepto la referencia ${reference}.`) +
    ' Si ya ha realizado el pago, le rogamos que lo comunique al acreedor con el justificante correspondiente.';
  sectionTitle('Forma de pago', heightOf(payment, WIDTH, REGULAR, 10));
  paragraph(payment);
  paragraph(
    'Transcurrido el plazo sin que se haya atendido el pago, el acreedor podrá acudir a las vías de reclamación que procedan, incluida la judicial.',
    { gap: 14 },
  );

  // ---- Legal basis ----
  const articles = [
    'Art. 4: fija el plazo de pago, que es el pactado y, a falta de pacto, de treinta días naturales desde la recepción de las mercancías o la prestación de los servicios.',
    'Art. 5: el deudor incurre en mora, y debe los intereses, automáticamente por el mero incumplimiento del pago en plazo, sin necesidad de aviso de vencimiento ni intimación del acreedor.',
    'Art. 7: el interés de demora es el pactado en el contrato y, en su defecto, el tipo legal, que se fija para cada semestre natural (tipo del Banco Central Europeo más ocho puntos porcentuales) y se publica en el «Boletín Oficial del Estado».',
  ];
  if (withCompensation) {
    articles.push(
      'Art. 8: el acreedor tiene derecho a cobrar una cantidad fija de 40 euros por costes de cobro, que se añade a la deuda principal.',
    );
  }
  // The whole section stays together: a legal basis cut in two pages reads badly.
  const introText =
    'Esta reclamación se funda en la Ley 3/2004, de 29 de diciembre, por la que se establecen medidas de lucha contra la morosidad en las operaciones comerciales:';
  ensureSpace(
    heightOf('Fundamento legal', WIDTH, BOLD, 11) +
      heightOf(introText, WIDTH, REGULAR, 10) +
      articles.reduce(
        (sum, article) => sum + heightOf(article, WIDTH - 14, REGULAR, 9) + 3,
        0,
      ) +
      30,
  );
  sectionTitle('Fundamento legal', 0); // the section was already kept together above
  paragraph(introText, { gap: 4 });
  for (const article of articles) {
    const height = heightOf(article, WIDTH - 14, REGULAR, 9);
    ensureSpace(height);
    style(REGULAR, 9).text('•', MARGIN_X + 2, y, { width: 10 });
    style(REGULAR, 9).text(article, MARGIN_X + 14, y, { width: WIDTH - 14 });
    y += height + 3;
  }
  y += 10;

  ensureSpace(60);
  paragraph('Atentamente,', { gap: 2 });
  paragraph(sender.name, { font: BOLD, gap: 16 });

  // ---- Disclaimer ----
  paragraph(
    'Aviso: este requerimiento es una plantilla generada por la herramienta Reclama a partir de los datos introducidos por el acreedor. No es asesoramiento jurídico ni sustituye la revisión por un profesional; el acreedor es responsable de la exactitud de los datos que contiene.',
    { font: ITALIC, size: 8, color: COLOR.muted, gap: 0 },
  );

  // ---- Annex: the frozen interest of every invoice ----
  y += 24;
  ensureSpace(140); // the title, its explanation and the first invoice stay together
  paragraph('Anexo: cálculo de los intereses de demora', {
    font: BOLD,
    size: 12,
    color: COLOR.accent,
    gap: 6,
  });
  paragraph(
    `Interés simple sobre el principal pendiente, desde el día siguiente al vencimiento hasta el ${formatDate(data.asOf)} (ambos incluidos), en tramos de tipo constante: intereses = principal × tipo anual × días / días del año.`,
    { size: 9, color: COLOR.muted, gap: 12 },
  );
  const segmentColumns: Column[] = [
    { header: 'Desde', width: 66, align: 'left' },
    { header: 'Hasta', width: 66, align: 'left' },
    { header: 'Días', width: 40, align: 'right' },
    { header: 'Año', width: 40, align: 'right' },
    { header: 'Principal', width: 98, align: 'right' },
    { header: 'Tipo anual', width: 70, align: 'right' },
    { header: 'Intereses', width: 103.28, align: 'right' },
  ];
  for (const invoice of data.invoices) {
    const number = clean(invoice.number);
    const interest = formatEUR(invoice.interest);
    const titleWidth = WIDTH - 130;
    const titleHeight = Math.max(
      heightOf(`Factura ${number}`, titleWidth, BOLD, 10),
      heightOf(`Factura ${number} (continuación)`, titleWidth, BOLD, 10),
    );
    table(
      segmentColumns,
      invoice.segments.map((s) => [
        formatDate(s.start),
        formatDate(s.end),
        String(s.days),
        String(s.yearDays),
        formatEUR(s.balance),
        formatRate(s.rateBp),
        formatEUR(s.interest),
      ]),
      {
        height: titleHeight + 6,
        draw: (continued) => {
          style(BOLD, 10).text(
            continued
              ? `Factura ${number} (continuación)`
              : `Factura ${number}`,
            MARGIN_X,
            y,
            { width: titleWidth },
          );
          style(BOLD, 10).text(
            `Intereses: ${interest}`,
            MARGIN_X + titleWidth,
            y,
            {
              width: 130,
              align: 'right',
            },
          );
          y += titleHeight + 6;
        },
      },
    );
    y += 14;
  }
}

// The header of the pages after the first and the footer of every page, once the number of pages
// is known. Text below the bottom margin would make pdfkit add a page, so the margin is lowered
// while it is drawn, and every line is cut to fit on one line.
function decoratePages(doc: Doc, data: LetterData): void {
  const senderName = clean(data.sender.name);
  const debtorName = clean(data.debtor.name);
  const reference = referenceOf(data.claimId);
  const { start, count } = doc.bufferedPageRange();

  const fit = (text: string, width: number): string => {
    let result = text;
    while (result.length > 1 && doc.widthOfString(result) > width) {
      result = `${result.slice(0, Math.max(0, result.length - 2)).trimEnd()}…`;
    }
    return result;
  };

  for (let index = 0; index < count; index += 1) {
    doc.switchToPage(start + index);
    doc.page.margins.bottom = 0;
    doc.font(REGULAR).fontSize(8).fillColor(COLOR.muted);

    if (index > 0) {
      const text = fit(
        `Requerimiento de pago a ${debtorName} · ${reference} (continuación)`,
        WIDTH,
      );
      doc.text(text, MARGIN_X, 30, { lineBreak: false });
    }

    const footerY = PAGE_HEIGHT - 44;
    doc
      .moveTo(MARGIN_X, footerY - 8)
      .lineTo(MARGIN_X + WIDTH, footerY - 8)
      .lineWidth(0.5)
      .strokeColor(COLOR.line)
      .stroke();
    const pageText = `Página ${String(index + 1)} de ${String(count)}`;
    const pageWidth = doc.widthOfString(pageText);
    doc.text(pageText, MARGIN_X + WIDTH - pageWidth, footerY, {
      lineBreak: false,
    });
    doc.text(
      fit(
        `${senderName} · Requerimiento de pago ${reference}`,
        WIDTH - pageWidth - 16,
      ),
      MARGIN_X,
      footerY,
      { lineBreak: false },
    );
  }
}

// The PDF bytes of the letter. Throws whatever pdfkit throws (not expected for sanitised text).
export function renderLetter(data: LetterData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: MARGIN_TOP,
          bottom: MARGIN_BOTTOM,
          left: MARGIN_X,
          right: MARGIN_X,
        },
        bufferPages: true,
        autoFirstPage: false,
        info: {
          Title: 'Requerimiento de pago',
          Author: clean(data.sender.name),
          Creator: 'Reclama',
          // The date of the letter, so that the same data always gives the same file.
          CreationDate: new Date(
            Date.UTC(
              Number(data.letterDate.slice(0, 4)),
              Number(data.letterDate.slice(5, 7)) - 1,
              Number(data.letterDate.slice(8, 10)),
            ),
          ),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', reject);

      doc.addPage();
      draw(doc, data);
      decoratePages(doc, data);
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('PDF failed'));
    }
  });
}
