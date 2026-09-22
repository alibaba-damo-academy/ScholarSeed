"""Cross-platform workspace locks and streaming child-process execution."""
from contextlib import contextmanager
import codecs
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time

from platform_runtime import utf8_env
from filelock import FileLock, Timeout


@contextmanager
def file_lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(path, timeout=0)
    try:
        lock.acquire()
    except Timeout as exc:
        raise BlockingIOError('Workspace operation already running: ' + str(path)) from exc
    try:
        yield lock
    finally:
        lock.release()


def process_options():
    return ({'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt'
            else {'start_new_session': True})


class ProcessJob:
    """Keep Windows descendants owned after their immediate parent exits."""
    def __init__(self, pid):
        self.handle = None
        if os.name != 'nt':
            return
        class Basic(c.Structure):
            _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64),
                        ('flags', w.DWORD), ('min_working_set', c.c_size_t),
                        ('max_working_set', c.c_size_t), ('active_processes', w.DWORD),
                        ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class Counters(c.Structure):
            _fields_ = [(name, c.c_uint64) for name in
                        ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
        class Limits(c.Structure):
            _fields_ = [('basic',Basic), ('io',Counters), ('process_memory',c.c_size_t),
                        ('job_memory',c.c_size_t), ('peak_process',c.c_size_t), ('peak_job',c.c_size_t)]
        api = c.WinDLL('kernel32', use_last_error=True)
        for name, restype, argtypes in (
            ('CreateJobObjectW',w.HANDLE,[c.c_void_p,w.LPCWSTR]),
            ('SetInformationJobObject',w.BOOL,[w.HANDLE,c.c_int,c.c_void_p,w.DWORD]),
            ('OpenProcess',w.HANDLE,[w.DWORD,w.BOOL,w.DWORD]),
            ('AssignProcessToJobObject',w.BOOL,[w.HANDLE,w.HANDLE]),
            ('CloseHandle',w.BOOL,[w.HANDLE])):
            function=getattr(api,name); function.restype=restype; function.argtypes=argtypes
        handle=api.CreateJobObjectW(None,None)
        if not handle:
            raise c.WinError(c.get_last_error())
        self.api=api; self.handle=handle
        limits=Limits(); limits.basic.flags=0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        process=None
        try:
            if not api.SetInformationJobObject(handle,9,c.byref(limits),c.sizeof(limits)):
                raise c.WinError(c.get_last_error())
            process=api.OpenProcess(0x0100 | 0x0001,False,pid)  # SET_QUOTA | TERMINATE
            if not process or not api.AssignProcessToJobObject(handle,process):
                raise c.WinError(c.get_last_error())
        except OSError:
            self.close()
            raise
        finally:
            if process:api.CloseHandle(process)

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle=None


def kill_process_tree(pid):
    if os.name == 'nt':
        # Use the OS executable directly, never a shell or an ambient PATH entry.
        tool = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/taskkill.exe'
        subprocess.run([str(tool), '/PID', str(pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    else:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_stream(command, cwd, log_path, env, timeout, progress=False):
    """Drain pipes on a reader thread: Windows selectors cannot poll pipes."""
    chunks, pending = [], ''
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    events = queue.Queue()
    with Path(log_path).open('a', encoding='utf-8') as log:
        log.write('\n[slr] ' + ' '.join(command) + '\n')
        log.flush()
        process = subprocess.Popen(command, cwd=str(cwd), env=utf8_env(env),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0, **process_options())
        try:
            job = ProcessJob(process.pid)
        except OSError:
            # A fast command can finish before assignment. A still-running
            # process must not continue without ownership in a restricted host.
            if process.poll() is None:
                kill_process_tree(process.pid); process.wait(); process.stdout.close()
                raise
            job = None

        def drain():
            try:
                while data := process.stdout.read(65536):
                    events.put(data)
            finally:
                events.put(None)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    data = events.get(timeout=min(remaining, .25))
                except queue.Empty:
                    continue
                if data is None:
                    tail = decoder.decode(b'', final=True)
                    chunks.append(tail); log.write(tail)
                    break
                text = decoder.decode(data)
                chunks.append(text); log.write(text); log.flush()
                if progress:
                    pending += text
                    while '\n' in pending:
                        line, pending = pending.split('\n', 1)
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(event, dict) and event.get('event') == 'llm_progress':
                            print(line, file=sys.stderr, flush=True)
            process.wait(timeout=max(.01, deadline - time.monotonic()))
            return process.returncode, ''.join(chunks)
        except subprocess.TimeoutExpired:
            if job and job.handle:job.close()
            else:kill_process_tree(process.pid)
            process.wait()
            log.write(f'\n[slr] timed out after {timeout}s\n')
            return 124, ''.join(chunks)
        except BaseException:
            if job and job.handle:job.close()
            else:kill_process_tree(process.pid)
            process.wait()
            raise
        finally:
            if job:job.close()
            reader.join(timeout=2)
            if not reader.is_alive():
                process.stdout.close()
