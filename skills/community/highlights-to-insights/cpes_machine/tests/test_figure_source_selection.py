"""V32 source selection: strict wire contract and unchanged full quotations."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO/'src'))

from cpes.figure_source_selection import prepare, assemble
from cpes.figures import validate_content
from cpes.card_review import assess_mechanism

class SourceSelection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root/'document.txt').write_text('Figure 2: Task compatibility.\n'
            'Figure 2 and Table 3 demonstrate the necessity\n'
            'FLOATING TABLE\n'
            'of task grouping for heterogeneous tasks.\n')
        (self.root/'figure.png').write_bytes(b'fixture image')
        self.job = {'image_files':[str(self.root/'figure.png')],
            'card_template':{'schema_version':7,'figure_id':'figure-2',
                'caption':{'number':'2','text':'Figure 2: Task compatibility.', 'number_source':'pdf-caption'},
                'source':{'tex_file':'document.txt'},'visual_status':'inspected','panels':[]},
            'context':{'figure_source':[{'line':1,'text':'Figure 2: Task compatibility.'}],
                'numbered_mentions':[{'file':'document.txt','reference_line':2,'context_issues':[],
                    'lines':[{'line':2,'text':'Figure 2 and Table 3 demonstrate the necessity'},
                             {'line':4,'text':'of task grouping for heterogeneous tasks.'}]}]}}
        self.raw = {'overview':'Task compatibility.', 'how_to_read':'Read rows against columns.',
                    'author_findings':[{'evidence_ids':['S1']}], 'prerequisites':[], 'scope':[]}

    def prepared(self):
        return prepare(self.job, self.root, repo=REPO)

    def test_complete_joint_original_and_disjoint_lines_reach_card_json(self):
        prepared = self.prepared(); original = copy.deepcopy(self.raw)
        card = assemble(self.raw, prepared, repo=REPO)
        finding = card['author_findings'][0]
        self.assertEqual(finding['claim'], 'Figure 2 and Table 3 demonstrate the necessity of task grouping for heterogeneous tasks.')
        self.assertEqual([(s['line_start'],s['line_end']) for s in finding['evidence']],[(2,2),(4,4)])
        self.assertEqual(finding['claim_origin'],'source_quote')
        self.assertEqual(self.raw, original)
        self.assertNotIn('panels',card)

    def test_api_request_uses_candidate_rules_and_only_api_schema(self):
        prepared = self.prepared(); req = prepared['api_request']
        schema = req['text']['format']['schema']
        validate_content(self.raw,schema)
        self.assertNotIn('claim',schema['properties']['author_findings']['items']['properties'])
        self.assertNotIn('enum',schema['properties']['author_findings']['items']['properties']['evidence_ids']['items'])
        self.assertEqual(req['reasoning'],{'effort':'none'})
        self.assertEqual(len(req['input'][0]['content']),2)
        self.assertNotIn('OUTPUT FIELD CONTRACT',req['input'][0]['content'][0]['text'])
        self.assertNotIn('reader_candidate',self.job)  # caller-owned job is unchanged

    def test_injected_claim_invalid_ids_empty_and_duplicates_fail_without_repair(self):
        for findings in ([{'claim':'Figure 2 alone proves necessity.','evidence_ids':['S1']}],
                         [{'evidence_ids':['L2']}], [{'evidence_ids':[]}],
                         [{'evidence_ids':['S1','S1']}],
                         [{'evidence_ids':['S1']},{'evidence_ids':['S1']}],
                         [{'evidence_ids':[5]}]):
            with self.subTest(findings=findings):
                raw={**self.raw,'author_findings':findings}; original=copy.deepcopy(raw)
                with self.assertRaises(ValueError):assemble(raw,self.prepared(),repo=REPO)
                self.assertEqual(raw,original)

    def test_each_selected_id_remains_a_separate_complete_source_quote(self):
        card=assemble({**self.raw,'author_findings':[{'evidence_ids':['C1','S1']}]},self.prepared(),repo=REPO)
        self.assertEqual(len(card['author_findings']),2)
        self.assertEqual([v['evidence_unit_ids'] for v in card['author_findings']],[['C1'],['S1']])

    def test_empty_findings_are_allowed_and_how_to_read_can_be_array(self):
        raw={**self.raw,'author_findings':[],'how_to_read':['Read rows.']}
        self.assertEqual(assemble(raw,self.prepared(),repo=REPO)['author_findings'],[])

    def test_source_or_image_changed_after_prepare_fails_closed(self):
        for name in ('document.txt','figure.png'):
            with self.subTest(name=name):
                prepared=self.prepared();p=self.root/name;original=p.read_bytes()
                p.write_bytes(original+b'changed')
                with self.assertRaises(ValueError):assemble(self.raw,prepared,repo=REPO)
                p.write_bytes(original)

    def test_job_or_catalog_tampering_fails_closed(self):
        for key in ('job','catalog'):
            with self.subTest(key=key):
                prepared=self.prepared()
                if key=='job':prepared[key]['context']['figure_source'][0]['text']='Changed caption.'
                else:prepared[key]['S1']['text']='Only Figure 2 proves it.'
                with self.assertRaises(ValueError):assemble(self.raw,prepared,repo=REPO)

    def test_caption_only_ocr_material_needs_no_body_units(self):
        self.job['context']['numbered_mentions']=[]
        card=assemble({**self.raw,'author_findings':[{'evidence_ids':['C1']}]},self.prepared(),repo=REPO)
        self.assertEqual(card['author_findings'][0]['claim'],'Figure 2: Task compatibility.')

    def test_original_json_text_is_accepted_without_repair(self):
        text=json.dumps(self.raw)
        self.assertEqual(assemble(text,self.prepared(),repo=REPO)['author_findings'][0]['evidence_unit_ids'],['S1'])

    def test_duplicate_json_keys_are_rejected(self):
        text=json.dumps(self.raw)[:-1]+',"author_findings":[]}'
        with self.assertRaisesRegex(ValueError,'duplicate JSON key'):
            assemble(text,self.prepared(),repo=REPO)


class WholeCardReview(unittest.TestCase):
    def setUp(self):
        self.card={'overview':'The backbone is frozen.', 'how_to_read':['B is the frozen backbone.'],
                   'author_findings':[], 'prerequisites':[], 'scope':[]}
        self.annotation={'reviewed_fields':list(self.card),
            'correct_mentions':[{'field':'overview','quote':'The backbone is frozen.'}],
            'contradictions':[{'field':'how_to_read','quote':'B is the frozen backbone.',
                              'source':'Figure 1 image','expected':'A and B are trainable low-rank adapter matrices.'}]}

    def test_correct_sentence_does_not_cancel_contradiction_elsewhere(self):
        result=assess_mechanism(self.card,self.annotation)
        self.assertTrue(result['correct_mechanism_mentioned'])
        self.assertEqual(result['whole_card_status'],'contradicted')

    def test_partial_review_cannot_be_called_full_card_pass(self):
        note={**self.annotation,'contradictions':[],'reviewed_fields':['overview']}
        self.assertEqual(assess_mechanism(self.card,note)['whole_card_status'],'not_fully_reviewed')

    def test_review_annotations_must_quote_actual_fields(self):
        note=copy.deepcopy(self.annotation);note['contradictions'][0]['quote']='not in the output'
        with self.assertRaises(ValueError):assess_mechanism(self.card,note)

    def test_full_review_records_no_detected_contradiction_without_claiming_proof(self):
        self.card['how_to_read']=['A and B are trainable.']
        note={**self.annotation,'contradictions':[]}
        self.assertEqual(assess_mechanism(self.card,note)['whole_card_status'],'supported_no_contradiction_found')

    def test_missing_or_unreviewed_content_field_is_not_full_review(self):
        self.card.pop('scope')
        note={**self.annotation,'contradictions':[],'reviewed_fields':list(self.card)}
        self.assertEqual(assess_mechanism(self.card,note)['whole_card_status'],'not_fully_reviewed')
        self.card['panels']=['B is the frozen backbone.']
        self.card['scope']=[]
        self.assertEqual(assess_mechanism(self.card,note)['whole_card_status'],'not_fully_reviewed')


if __name__ == '__main__':
    unittest.main()
