import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from qr_codes import bay_urls, export, printable_pdf, public_origin
from server import deployment_origin


class QRCodes(unittest.TestCase):
    def test_https_origin_and_no_sensitive_query(self):
        for value in ['', 'http://example.com', 'https://localhost', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?token=secret', 'https://example.com#fragment']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                public_origin(value)
        self.assertEqual(public_origin('https://club.example/'), 'https://club.example')
        self.assertEqual(bay_urls('https://club.example', [1, 6]), {1: 'https://club.example/bay/1', 6: 'https://club.example/bay/6'})

    def test_export_complete_printable_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            export('https://club.example', range(1, 7), tmp)
            root = Path(tmp)
            self.assertEqual(len(list(root.glob('bay-*.svg'))), 6)
            pdf = (root / 'YENGolf-bay-QR-codes.pdf').read_bytes()
            self.assertTrue(pdf.startswith(b'%PDF-'))
            self.assertGreater(len(pdf), 5000)
            links = json.loads((root / 'bay-links.json').read_text())
            self.assertEqual(links['6'], 'https://club.example/bay/6')
            self.assertIn('<svg', (root / 'bay-1.svg').read_text())

    def test_render_origin_fallback_and_custom_domain_override(self):
        with patch.dict('os.environ', {'RENDER_EXTERNAL_URL': 'https://assigned.onrender.com'}, clear=True):
            self.assertEqual(deployment_origin(), 'https://assigned.onrender.com')
        with patch.dict('os.environ', {'RENDER_EXTERNAL_URL': 'https://assigned.onrender.com', 'VC_PUBLIC_URL': 'https://club.example'}, clear=True):
            self.assertEqual(deployment_origin(), 'https://club.example')

    def test_multiple_pages_and_invalid_bays(self):
        self.assertTrue(printable_pdf('https://club.example', range(1, 9)).startswith(b'%PDF-'))
        for bays in [[], [1, 1], [0], ['1']]:
            with self.assertRaises(ValueError):
                bay_urls('https://club.example', bays)


if __name__ == '__main__':
    unittest.main()
