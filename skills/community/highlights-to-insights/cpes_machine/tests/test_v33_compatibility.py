"""Provider wire compatibility must not weaken local evidence validation."""
import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import test_figure_source_selection as fixtures
from cpes.figure_source_selection import prepare,assemble,configuration
from cpes.api_diagnostics import provider_error


REPO=fixtures.REPO


class WireCompatibility(fixtures.SourceSelection):
    def prepared(self):
        return prepare(self.job,self.root,repo=REPO,version='V33')

    def test_wire_omits_unique_but_local_duplicate_guard_remains(self):
        prepared=self.prepared()
        self.assertNotIn('uniqueItems',str(prepared['api_request']['text']['format']['schema']))
        self.assertTrue(configuration(REPO,'V33')['schema']['properties']['author_findings']['items']['properties']['evidence_ids']['uniqueItems'])
        bad={**self.raw,'author_findings':[{'evidence_ids':['S1','S1']}]}
        with self.assertRaises(ValueError):assemble(bad,prepared,repo=REPO)

    def test_only_unique_items_removed_from_wire(self):
        old=configuration(REPO);new=configuration(REPO,'V33')
        expected=copy.deepcopy(old['schema'])
        expected['properties']['author_findings']['items']['properties']['evidence_ids'].pop('uniqueItems')
        self.assertEqual(new['request_schema'],expected)
        self.assertEqual(old['schema'],new['schema'])
        self.assertEqual(old['prefix'],new['prefix'])


class ProviderDiagnostics(unittest.TestCase):
    def test_error_retains_reason_code_parameter_and_request_id_without_secret(self):
        class Failure(Exception):
            status_code=400
            request_id='req-123'
            body={'error':{'code':'invalid_json_schema','param':'text.format.schema',
                          'message':'uniqueItems unsupported; key=secret-value'}}
        result=provider_error(Failure(),secrets=['secret-value'])
        self.assertEqual(result['http_status'],400)
        self.assertEqual(result['code'],'invalid_json_schema')
        self.assertEqual(result['param'],'text.format.schema')
        self.assertEqual(result['request_id'],'req-123')
        self.assertIn('uniqueItems unsupported',result['message'])
        self.assertNotIn('secret-value',str(result))

    def test_error_without_provider_body_is_not_invented(self):
        result=provider_error(TimeoutError())
        self.assertIsNone(result['message'])
        self.assertEqual(result['error'],'TimeoutError')


if __name__=='__main__':unittest.main()
