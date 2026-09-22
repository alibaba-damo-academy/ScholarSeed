import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib/_fast"))
from light_llm import _OpenAICompatLLM


class StreamCaptureTest(unittest.TestCase):
    def test_usage_only_chunk_and_actual_model_are_preserved(self):
        class Usage(SimpleNamespace):
            def model_dump(self):
                return {"prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens}
        usage = Usage(prompt_tokens=10, completion_tokens=3)
        class Stream:
            closed = False
            def __aiter__(self):
                async def items():
                    yield SimpleNamespace(model="observed-model", usage=None, choices=[SimpleNamespace(
                        delta=SimpleNamespace(content="OK", reasoning_content=""), finish_reason="stop")])
                    yield SimpleNamespace(model="observed-model", usage=usage, choices=[])
                return items()
            async def close(self):
                self.closed = True
        stream = Stream()
        sent = []
        async def create(**kwargs):
            sent.append(kwargs)
            return stream
        api = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with patch("openai.AsyncOpenAI", return_value=api):
            model = _OpenAICompatLLM("requested-model", "https://fixture.invalid/v1", "fixture-token")
        capture = {}
        text = asyncio.run(model.chat_stream([{"role": "user", "content": "fixture"}], _capture=capture))
        self.assertEqual(text, "OK")
        self.assertEqual(capture["usage"], {"prompt_tokens": 10, "completion_tokens": 3})
        self.assertEqual(capture["response_models"], ["observed-model"])
        self.assertEqual(capture["finish_reason"], "stop")
        self.assertNotIn("_capture", sent[0])
        self.assertTrue(stream.closed)

    def test_failed_stream_preserves_partial_text_and_known_usage(self):
        class Usage(SimpleNamespace):
            def model_dump(self):
                return {"prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens}
        for usage in [None, Usage(prompt_tokens=10, completion_tokens=3)]:
            class Stream:
                def __aiter__(self):
                    async def items():
                        yield SimpleNamespace(model="observed-model", usage=usage, choices=[SimpleNamespace(
                            delta=SimpleNamespace(content="partial", reasoning_content=""), finish_reason=None)])
                        raise RuntimeError("disconnected")
                    return items()
                async def close(self):
                    pass
            async def create(**kwargs):
                return Stream()
            api = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
            with patch("openai.AsyncOpenAI", return_value=api):
                model = _OpenAICompatLLM("requested-model", "https://fixture.invalid/v1", "fixture-token")
            capture = {}
            with self.assertRaisesRegex(RuntimeError, "disconnected"):
                asyncio.run(model.chat_stream([], _capture=capture))
            self.assertEqual(capture["partial_response"], "partial")
            self.assertEqual(capture["response_models"], ["observed-model"])
            self.assertEqual(model.summary()["failures"], 1)
            self.assertEqual(model.summary()["calls"], 1)
            self.assertEqual(model.summary()["usage_missing_calls"], int(usage is None))
            self.assertEqual(model.summary()["prompt_tokens"], 10 if usage else 0)

    def test_close_failure_preserves_capture_and_counts_request_once(self):
        class Usage(SimpleNamespace):
            def model_dump(self):
                return {"prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens}
        for read_fails in [False, True]:
            for usage in [None, Usage(prompt_tokens=10, completion_tokens=3)]:
                with self.subTest(read_fails=read_fails, usage_known=usage is not None):
                    class Stream:
                        def __aiter__(self):
                            async def items():
                                yield SimpleNamespace(model="observed-model", usage=usage, choices=[SimpleNamespace(
                                    delta=SimpleNamespace(content="received response", reasoning_content=""),
                                    finish_reason=None if read_fails else "stop")])
                                if read_fails:
                                    raise RuntimeError("fixture read failed")
                            return items()
                        async def close(self):
                            raise RuntimeError("fixture close failed")
                    async def create(**kwargs):
                        return Stream()
                    api = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
                    with patch("openai.AsyncOpenAI", return_value=api):
                        model = _OpenAICompatLLM("requested-model", "https://fixture.invalid/v1", "fixture-token")
                    capture = {}
                    expected_error = "fixture read failed" if read_fails else "fixture close failed"
                    with self.assertRaisesRegex(RuntimeError, expected_error):
                        asyncio.run(model.chat_stream([], _capture=capture))
                    self.assertEqual(capture["partial_response"], "received response")
                    self.assertEqual(capture["response_models"], ["observed-model"])
                    self.assertEqual(capture["finish_reason"], None if read_fails else "stop")
                    self.assertEqual(capture["usage"], usage.model_dump() if usage is not None else None)
                    summary = model.summary()
                    self.assertEqual(summary["calls"], 1)
                    self.assertEqual(summary["failures"], 1)
                    self.assertEqual(summary["usage_missing_calls"], int(usage is None))
                    self.assertEqual(summary["prompt_tokens"], 10 if usage is not None else 0)
                    self.assertEqual(summary["completion_tokens"], 3 if usage is not None else 0)

if __name__ == "__main__":
    unittest.main()
