import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function qrPdf(origin, bays) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('YENGolf Virtual Club - Bay QR Codes');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const heading = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const red = rgb(182 / 255, 42 / 255, 45 / 255), ink = rgb(34 / 255, 34 / 255, 35 / 255);
  let page;
  const center = (value, x, y, size, face = font, color = ink) => page.drawText(value, { x: x - face.widthOfTextAtSize(value, size) / 2, y, size, font: face, color });
  for (let i = 0; i < bays.length; i++) {
    const slot = i % 6;
    if (!slot) {
      page = pdf.addPage([595.28, 841.89]);
      page.drawText('YENGOLF VIRTUAL CLUB', { x: 24, y: 810, font: heading, size: 21, color: red });
      page.drawText('Print at 100% scale. Place each code at its matching bay.', { x: 24, y: 794, font, size: 8, color: ink });
    }
    const x = 24 + (slot % 2) * 273.64, y = 780 - (Math.floor(slot / 2) + 1) * 245, cx = x + 136.82;
    page.drawRectangle({ x: x + 3, y: y + 3, width: 267.64, height: 239, borderWidth: 0.5, borderColor: rgb(230 / 255, 168 / 255, 168 / 255) });
    center(`BAY ${bays[i].id}`, cx, y + 215, 23, heading, red);
    center('SCAN TO ORDER DRINKS', cx, y + 199, 8);
    const url = `${origin}/bay/${bays[i].id}`;
    const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const unit = 150 / (modules.size + 8);
    for (let row = 0; row < modules.size; row++) for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) page.drawRectangle({ x: cx - 75 + (col + 4) * unit, y: y + 37 + (modules.size + 3 - row) * unit, width: unit + 0.01, height: unit + 0.01, color: rgb(0, 0, 0) });
    }
    center(url, cx, y + 24, Math.min(6, 250 / font.widthOfTextAtSize(url, 1)));
    center('Reception must open your bay before ordering.', cx, y + 12, 7);
  }
  return pdf.save();
}
