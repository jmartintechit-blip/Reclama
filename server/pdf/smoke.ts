import PDFDocument from 'pdfkit';

// TEMPORARY, like the route that calls it (server/routes/smoke.ts): delete it when the real letter exists (plan task T23).
// The whole PDF is built in memory as one Buffer: if PDFKit throws, the promise rejects before any byte is sent.
export function renderSmokePdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    // Fixed date on purpose: PDFKit stamps the current time, so every download would differ. With a fixed
    // date the same bytes come out every time, and the deployment check can compare the SHA-256 of the file.
    const doc = new PDFDocument({
      info: { CreationDate: new Date(Date.UTC(2026, 9, 11)) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    // Standard Helvetica needs no font file. PDFKit writes its text in WinAnsi (Windows-1252),
    // which has the euro sign and every Spanish letter, so this is what the smoke test checks.
    doc.font('Helvetica').fontSize(18).text('PDF smoke test');
    doc.fontSize(12).text('€ áéíóúñ ÁÉÍÓÚÑ ü ¿¡');
    doc.text('1.234,56 €');
    doc.end();
  });
}
