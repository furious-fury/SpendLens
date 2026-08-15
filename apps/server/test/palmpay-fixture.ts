import { PDFDocument, StandardFonts } from "pdf-lib";

interface FixtureOptions {
  creditTransactionId?: string;
  declaredInflow?: string;
  declaredOutflow?: string;
  debitTransactionId?: string;
  includeText?: boolean;
  pageCount?: number;
  marker?: string;
  repeatFirstRow?: boolean;
}

export async function createSanitizedPalmPayPdf(options: FixtureOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pageCount = options.pageCount ?? 1;
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([595, 842]);
    if (index > 0 || options.includeText === false) continue;
    const draw = (text: string, x: number, y: number, size = 8) =>
      page.drawText(text, { x, y, size, font });

    draw("PalmPay support@palmpay.com", 26, 740, 12);
    if (options.marker) draw(options.marker, 26, 720, 6);
    draw("Account Statement", 26, 694, 16);
    draw("Account Number", 359, 677);
    draw("000 000 4321", 500, 677);
    draw("Total Money In", 26, 660);
    draw(options.declaredInflow ?? "1,000.00", 139, 660);
    draw("Statement Period", 359, 660);
    draw("06/01/2026 - 06/30/2026", 477, 660);
    draw("Total Money Out", 26, 645);
    draw(options.declaredOutflow ?? (options.repeatFirstRow ? "0.00" : "250.50"), 139, 645);
    draw("Transaction Date", 26, 614);
    draw("Transaction Detail", 139, 614);
    draw("Money In (NGN)", 252, 614);
    draw("Money Out (NGN)", 371, 614);
    draw("Transaction ID", 476, 614);

    draw("06/30/2026 02:30:10 PM", 26, 570);
    draw("Received from", 139, 586);
    draw("Example", 139, 578);
    draw("Client", 139, 570);
    draw("+1000.00", 252, 570);
    draw(options.creditTransactionId ?? "fixture-credit-001", 476, 570);

    if (options.repeatFirstRow) {
      draw("06/30/2026 02:30:10 PM", 26, 530);
      draw("Received from", 139, 546);
      draw("Example", 139, 538);
      draw("Client", 139, 530);
      draw("+1000.00", 252, 530);
      draw(options.creditTransactionId ?? "fixture-credit-001", 476, 530);
    } else {
      draw("06/29/2026 01:10:00 PM", 26, 530);
      draw("Send to Example Store", 139, 534);
      draw("Lagos", 139, 526);
      draw("-250.50", 371, 530);
      if (options.debitTransactionId) {
        draw(options.debitTransactionId, 476, 530);
      } else {
        draw("fixture-debit-", 476, 534);
        draw("002", 476, 526);
      }
    }
  }
  return pdf.save();
}
