"""Printable bay QR codes. The deployment origin is required; no guessed domains."""
import argparse
from io import BytesIO
import json
from pathlib import Path
from urllib.parse import urlsplit

from reportlab.graphics import renderPDF, renderSVG
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen.canvas import Canvas


def public_origin(value):
    value = value.strip().rstrip('/')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment
            or parsed.hostname in ['localhost', '127.0.0.1', '0.0.0.0']):
        raise ValueError('Set the confirmed public HTTPS origin before generating QR codes.')
    return value


def bay_urls(origin, bays):
    origin = public_origin(origin)
    ids = list(bays)
    if not ids or len(set(ids)) != len(ids) or any(type(i) is not int or i < 1 for i in ids):
        raise ValueError('Supply unique positive bay numbers.')
    return {i: f'{origin}/bay/{i}' for i in ids}


def qr_drawing(url, size=150):
    code = QrCodeWidget(url, barLevel='M', barBorder=4, barWidth=size, barHeight=size)
    drawing = Drawing(size, size)
    drawing.add(code)
    return drawing


def printable_pdf(origin, bays):
    urls = bay_urls(origin, bays)
    output = BytesIO()
    pdf = Canvas(output, pagesize=A4)
    pdf.setTitle('YENGolf Virtual Club — Bay QR Codes')
    pdf.setAuthor('YENGolf Virtual Club')
    width, height = A4
    ink, red, pink = map(HexColor, ['#222223', '#B62A2D', '#E6A8A8'])
    margin, header, card_h = 24, 62, 245
    card_w = (width - 2 * margin) / 2
    for index, (bid, url) in enumerate(urls.items()):
        slot = index % 6
        if slot == 0:
            if index:
                pdf.showPage()
            pdf.setFillColor(red)
            pdf.setFont('Times-Bold', 21)
            pdf.drawString(margin, height - 30, 'YENGOLF VIRTUAL CLUB')
            pdf.setFont('Helvetica', 8)
            pdf.setFillColor(ink)
            pdf.drawString(margin, height - 45, 'Print at 100% scale. Cut along the borders and place each code at its matching bay.')
        x = margin + (slot % 2) * card_w
        y = height - header - (slot // 2 + 1) * card_h
        pdf.setStrokeColor(pink)
        pdf.setDash(2, 3)
        pdf.rect(x + 3, y + 3, card_w - 6, card_h - 6)
        pdf.setDash()
        cx = x + card_w / 2
        pdf.setFillColor(red)
        pdf.setFont('Times-Bold', 23)
        pdf.drawCentredString(cx, y + card_h - 30, f'BAY {bid}')
        pdf.setFillColor(ink)
        pdf.setFont('Helvetica', 8)
        pdf.drawCentredString(cx, y + card_h - 46, 'SCAN TO ORDER DRINKS')
        renderPDF.draw(qr_drawing(url), pdf, cx - 75, y + 37)
        pdf.setFont('Helvetica', 6)
        pdf.drawCentredString(cx, y + 24, url)
        pdf.setFont('Helvetica', 7)
        pdf.drawCentredString(cx, y + 12, 'Reception must open your bay before ordering.')
    pdf.save()
    return output.getvalue()


def export(origin, bays, directory):
    urls = bay_urls(origin, bays)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'YENGolf-bay-QR-codes.pdf').write_bytes(printable_pdf(origin, urls))
    for bid, url in urls.items():
        renderSVG.drawToFile(qr_drawing(url, 512), str(directory / f'bay-{bid}.svg'))
    (directory / 'bay-links.json').write_text(json.dumps(urls, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='Confirmed HTTPS origin, without a path')
    parser.add_argument('--bays', type=int, default=6)
    parser.add_argument('--output', type=Path, default=Path('.runtime/qr-codes'))
    args = parser.parse_args()
    export(args.url, range(1, args.bays + 1), args.output)
    print(f'Created printable PDF, individual SVG codes and bay link list in {args.output}')
