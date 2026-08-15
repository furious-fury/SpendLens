import { PDFDocument, StandardFonts } from "pdf-lib";

export async function createSanitizedOPayPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  const draw = (text: string, x: number, y: number, size = 7) =>
    page.drawText(text, { x, y, size, font });

  draw("OPay", 66, 720, 12);
  draw("Account Statement", 241, 686, 16);
  draw("Account Name", 66, 646);
  draw("Sanitized Example", 66, 635);
  draw("Account Number", 224, 646);
  draw("0000004321", 224, 635);
  draw("Wallet Account", 66, 579);
  draw("Period:", 224, 580);
  draw("01 Jan 2026 - 31 Jul 2026", 249, 580);
  draw("Opening Balance", 66, 551);
  draw("0.00", 70, 541);
  draw("Total Debit", 224, 551);
  draw("250.50", 228, 541);
  draw("Debit Count", 383, 551);
  draw("1", 383, 541);
  draw("Closing Balance", 66, 515);
  draw("749.50", 70, 505);
  draw("Total Credit", 224, 515);
  draw("1,000.00", 228, 505);
  draw("Credit Count", 383, 515);
  draw("1", 383, 505);

  draw("Trans. Time", 71, 458);
  draw("Value Date", 132, 458);
  draw("Description", 180, 458);
  draw("Debit(N)", 301, 458);
  draw("Credit(N)", 339, 458);
  draw("Balance After(N)", 378, 458);
  draw("Channel", 420, 458);
  draw("Transaction Reference", 477, 458);

  draw("30 Jun 2026 14:30:10", 71, 425);
  draw("30 Jun 2026", 132, 425);
  draw("Received from", 180, 431);
  draw("Example Client", 180, 419);
  draw("--", 301, 425);
  draw("1,000.00", 339, 425);
  draw("1,000.00", 378, 425);
  draw("Mobile", 420, 425);
  draw("fixture-credit-", 477, 431);
  draw("001", 477, 419);

  draw("29 Jun 2026 13:10:00", 71, 380);
  draw("29 Jun 2026", 132, 380);
  draw("Send to Example Store", 180, 380);
  draw("250.50", 301, 380);
  draw("--", 339, 380);
  draw("749.50", 378, 380);
  draw("Mobile", 420, 380);
  draw("fixture-debit-002", 477, 380);

  return pdf.save();
}
