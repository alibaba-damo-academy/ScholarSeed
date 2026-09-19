import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from review_reading import export_reading

class ReviewReadingTest(unittest.TestCase):
    def test_all_text_survives_utf8_chunks_and_stable_block_identity(self):
        texts = ['', '中文🙂' * 2500, 'Theorem with assumptions.\n\\alpha and citations.']
        packet = {'base_sha256': 'fixture', 'blocks': [
            {'id': f'p{i}', 'sha256': hashlib.sha256(t.encode()).hexdigest(), 'text': t}
            for i, t in enumerate(texts, 1)], 'patch_schema': {'edits': []}}
        original = json.dumps(packet)
        with tempfile.TemporaryDirectory() as tmp:
            result = export_reading(packet, tmp)
            manifest = json.loads(Path(result['reading_index']).read_text())
            root = Path(result['reading_directory'])
            self.assertFalse(result['review_complete'])
            for block in packet['blocks']:
                restored = ''
                for entry in manifest['files']:
                    data = (root / entry['file']).read_bytes()
                    self.assertLessEqual(len(data), 3500)
                    self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
                    for segment in entry['segments']:
                        if segment['block_id'] != block['id']:
                            continue
                        value = data[segment['offset_bytes']:segment['offset_bytes'] + segment['bytes']]
                        self.assertEqual(hashlib.sha256(value).hexdigest(), segment['sha256'])
                        self.assertEqual(segment['block_sha256'], block['sha256'])
                        restored += value.decode('utf-8')
                self.assertEqual(restored, block['text'])
            self.assertEqual(json.dumps(packet), original)
            self.assertEqual(export_reading(packet, tmp), result)

if __name__ == '__main__':
    unittest.main()
