import { qrPdf } from '../shared/qr-pdf.mjs';

// Runs on the Reception computer, so QR/PDF work does not consume a free Worker's CPU.
export async function downloadQrSheet(info) {
  const bays = Object.keys(info.bays).map(id => ({ id: Number(id) }));
  const bytes = await qrPdf(info.origin, bays);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'YENGolf-bay-QR-codes.pdf';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
