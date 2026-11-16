"""One ephemeral App Server turn with incremental final-answer text; no retries."""
import json
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

from cpes.contracts import CpesError


class StreamingBackend:
    def __init__(self, executable='codex', model=None, profile=None, timeout=300):
        self.executable, self.model, self.profile, self.timeout = executable, model, profile, timeout

    def generate(self, prompt, schema, images, on_delta):
        usage = {'usage_events': [], 'exit_code': None}
        def error(code, message):
            return CpesError(code, message, usage=usage)
        if self.timeout <= 0:
            raise ValueError('Timeout must be positive.')
        if self.profile:
            raise error('stream_profile_unsupported', '当前 App Server 不支持 --profile；未启动生成。可显式选择非流式方式，或重新准备不含 profile 的请求。')
        command = [self.executable, 'app-server', '--stdio']
        with tempfile.TemporaryDirectory(prefix='hint-stream-') as tmp:
            try:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, text=True, encoding='utf-8', cwd=tmp,
                                           bufsize=1)
            except FileNotFoundError as exc:
                raise error('codex_unavailable', '未找到 Codex CLI。') from exc
            events = queue.Queue()
            def read():
                try:
                    for line in process.stdout:
                        events.put(line)
                finally:
                    events.put(None)
            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            deadline = time.monotonic() + self.timeout
            def send(value):
                try:
                    process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
                    process.stdin.flush()
                except (BrokenPipeError, OSError) as exc:
                    raise error('codex_failed', 'App Server 连接已关闭。') from exc
            def receive():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise error('model_timeout', 'Codex 流式调用超时。')
                try:
                    line = events.get(timeout=remaining)
                except queue.Empty as exc:
                    raise error('model_timeout', 'Codex 流式调用超时。') from exc
                if line is None:
                    raise error('codex_failed', 'App Server 在完成前退出。')
                try:
                    event = json.loads(line)
                except ValueError as exc:
                    raise error('invalid_model_json', 'App Server 事件格式无效。') from exc
                if not isinstance(event, dict):
                    raise error('invalid_model_json', 'App Server 事件格式无效。')
                if 'method' in event and 'id' in event:
                    # No tool/auth/approval conversation may create another model round.
                    raise error('unexpected_server_request', '纯写作调用收到额外交互请求；已停止，不自动重试。')
                return event
            def rpc(number, method, params):
                send({'id': number, 'method': method, 'params': params})
                while True:
                    event = receive()
                    if event.get('id') == number:
                        if 'error' in event:
                            raise error('codex_failed', f'App Server {method} 失败。')
                        return event.get('result', {})
            def emit(delta):
                try:
                    on_delta(delta)
                except Exception as exc:
                    raise error('stream_output_failed', '流式正文无法解析或显示；草稿未被接受。') from exc
            try:
                rpc(1, 'initialize', {'clientInfo': {'name': 'hint_writer', 'version': '1.0'}})
                send({'method': 'initialized', 'params': {}})
                params = {'cwd': str(Path(tmp).resolve()), 'ephemeral': True, 'sandbox': 'read-only',
                          'approvalPolicy': 'never',
                          'config': {'web_search': 'disabled', 'features.shell_tool': False},
                          'developerInstructions': ('Use only the supplied evidence. Do not call tools or read files. '
                              + ('Return only the supplied JSON schema.' if schema is not None
                                 else 'Return only the requested Markdown note.'))}
                if self.model:
                    params['model'] = self.model
                thread = rpc(2, 'thread/start', params)['thread']['id']
                inputs = [{'type': 'text', 'text': prompt}]
                inputs += [{'type': 'localImage', 'path': str(Path(p).resolve())} for p in images]
                # This is the only generation dispatch; never fall back or retry.
                turn_params = {'threadId': thread, 'input': inputs}
                if schema is not None:
                    turn_params['outputSchema'] = schema
                send({'id': 3, 'method': 'turn/start', 'params': turn_params})
                turn, message, streamed, final = None, None, '', None
                while True:
                    event = receive()
                    if event.get('id') == 3:
                        if 'error' in event:
                            raise error('codex_failed', 'App Server 拒绝生成请求。')
                        turn = event['result']['turn']['id']
                        continue
                    method, data = event.get('method'), event.get('params', {})
                    if data.get('threadId', thread) != thread:
                        continue
                    if turn is not None and data.get('turnId', turn) != turn:
                        continue
                    if method == 'error':
                        raise error('codex_failed', 'Codex 返回错误；已停止，不自动重试。')
                    if method == 'thread/tokenUsage/updated':
                        total = data['tokenUsage']['total']
                        names = {'inputTokens': 'input_tokens', 'cachedInputTokens': 'cached_input_tokens',
                                 'outputTokens': 'output_tokens', 'reasoningOutputTokens': 'reasoning_output_tokens',
                                 'totalTokens': 'total_tokens', 'cacheWriteInputTokens': 'cache_creation_input_tokens'}
                        # An ephemeral thread's total is cumulative, not another usage event to sum.
                        usage['usage_events'] = [{names[k]: v for k, v in total.items() if k in names}]
                    elif method in ('item/started', 'item/completed'):
                        item = data['item']
                        if item.get('type') not in ('agentMessage', 'reasoning', 'userMessage'):
                            raise error('unexpected_tool', '纯写作调用出现工具或额外操作；已停止，不自动重试。')
                        if item.get('type') == 'agentMessage':
                            if item.get('phase') == 'commentary':
                                raise error('unexpected_message', '写作者返回过程说明，未按结构化草稿生成。')
                            if message is None:
                                message = item['id']
                            if item['id'] != message:
                                raise error('unexpected_message', '写作者返回多个消息，无法作为一次连续草稿接受。')
                            if method == 'item/completed':
                                final = item.get('text', '')
                                if not final.startswith(streamed):
                                    raise error('stream_mismatch', '完整草稿与已显示的增量不一致。')
                                if final[len(streamed):]:
                                    emit(final[len(streamed):])
                                streamed = final
                    elif method == 'item/agentMessage/delta':
                        if message is None:
                            message = data['itemId']
                        if data['itemId'] != message or final is not None:
                            raise error('unexpected_message', '正文增量不属于当前草稿。')
                        delta = data['delta']
                        emit(delta)
                        streamed += delta
                    elif method == 'turn/completed':
                        if data['turn']['status'] != 'completed' or not final:
                            raise error('codex_failed', 'Codex 未完成草稿；预览不能作为正式笔记。')
                        if schema is not None:
                            try:
                                json.loads(final)
                            except ValueError as exc:
                                raise error('invalid_model_json', '完整草稿不是有效 JSON。') from exc
                        usage['exit_code'] = 0
                        return {'output_text': final, 'usage': usage}
            except KeyboardInterrupt as exc:
                exc.details = {'usage': usage}
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                process.stdin.close()
                reader.join(timeout=2)
                process.stdout.close()
