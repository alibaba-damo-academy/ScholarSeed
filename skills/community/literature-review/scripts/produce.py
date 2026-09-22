"""Compatibility parallel producer using the old section-writing interface.

Current tasks dispatch manuscript generate and the independent figure author."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def final_json(text):
    decoder = json.JSONDecoder()
    for pos in reversed([i for i, ch in enumerate(text) if ch == "{"]):
        try:
            obj, end = decoder.raw_decode(text, pos)
            if isinstance(obj, dict) and not text[end:].strip():
                return obj
        except ValueError:
            pass
    return {}


async def stop(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=3)
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await proc.wait()


async def run_components(workspace, commands):
    """Start every component before waiting; retain logs and cancel on failure."""
    ws = Path(workspace)
    run_id = uuid.uuid4().hex[:12]
    logs = ws / "_logs" / "produce" / run_id
    logs.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()

    async def one(name, command):
        path = logs / (name + ".log")
        begin = time.monotonic()
        result = {"component": name, "command": command, "log": str(path)}
        proc = None
        try:
            with path.open("wb") as stream:
                proc = await asyncio.create_subprocess_exec(
                    *command, cwd=str(ws), stdout=stream, stderr=asyncio.subprocess.STDOUT,
                    start_new_session=True)
                result["pid"] = proc.pid
                rc = await proc.wait()
            payload = final_json(path.read_text(errors="replace"))
            result.update(exit_code=rc, status=payload.get("status", "SUCCESS" if rc == 0 else "FAILED"),
                          report=payload)
            if rc != 0:
                result["status"] = "FAILED"
        except asyncio.CancelledError:
            result["status"] = "CANCELLED"
        except Exception as exc:
            result.update(status="FAILED", error=str(exc))
        finally:
            if proc is not None:
                await stop(proc)
            result["seconds"] = round(time.monotonic() - begin, 3)
            save(logs / (name + ".json"), result)
        return result

    tasks = {asyncio.create_task(one(name, command)): name for name, command in commands.items()}
    pending = set(tasks)
    results = []
    try:
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            batch = [task.result() for task in done]
            results.extend(batch)
            if any(row["status"] in ("FAILED", "CANCELLED") for row in batch):
                for task in pending:
                    task.cancel()
                results.extend(await asyncio.gather(*pending))
                pending.clear()
    finally:
        for task in pending:
            task.cancel()
        if pending:
            results.extend(await asyncio.gather(*pending))
    status = ("FAILED" if any(r["status"] in ("FAILED", "CANCELLED") for r in results)
              else "PARTIAL_SUCCESS" if any(r["status"] == "PARTIAL_SUCCESS" for r in results)
              else "SUCCESS")
    result = {"stage": "writing_produce", "status": status, "run_id": run_id,
              "seconds": round(time.monotonic() - started, 3), "components": results}
    result['generated_images'] = [str(p) for p in sorted((ws/'05_generation/figures').glob('*.png'))]
    result['next'] = 'Integrate generated assets, publish and verify. No generated-image review or automatic refinement.'
    save(logs / "result.json", result)
    save(ws / "05_generation/_status/writing_produce.json", result)
    return result


async def _produce(workspace, concurrency=3, repairs=1, only=None, overwrite=False, dry_run=False):
    import fcntl
    from writing_contract import require_approval, preparation_identity
    root = Path(__file__).resolve().parent
    ws = Path(workspace)
    require_approval(ws)
    manifest = json.loads((ws / "05_generation/_internal/drafting_worklist.json").read_text())
    if manifest.get("writing_contract_sha256") != preparation_identity(ws):
        raise ValueError("writing scope or outline changed: rerun generation_prep before produce")
    (ws / "05_generation/_internal").mkdir(parents=True, exist_ok=True)
    with (ws / "05_generation/_internal/produce.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Figure planning is semantic work owned by the main agent. Validate it
        # before paying for either branch; this command never invents a plan.
        check = await asyncio.create_subprocess_exec(
            sys.executable, str(root / "validate_figures_meta.py"), str(ws),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            output, _ = await check.communicate()
        finally:
            if check.returncode is None:
                check.kill()
                await check.wait()
        if check.returncode:
            result = {"stage": "writing_produce", "status": "FAILED",
                      "reason": "Complete the figure plan before produce; no model jobs started.",
                      "validation": output.decode(errors="replace")[-6000:]}
            save(ws / "05_generation/_status/writing_produce.json", result)
            return result
        writing = [sys.executable, str(root / "writing.py"), "draft", "--workspace", str(ws),
                   "--concurrency", str(concurrency), "--repairs", str(repairs)]
        if only:
            writing += ["--only", *only]
        if overwrite:
            writing.append("--overwrite")
        commands = {"drafting": writing}
        if dry_run:
            writing.append("--dry-run")
        else:
            commands["figures"] = [sys.executable, str(root / "slr.py"), "figures", "plan-generate",
                                   "--workspace", str(ws), "--concurrency", str(concurrency)]
        return await run_components(ws, commands)


async def produce(workspace, concurrency=3, repairs=1, only=None, overwrite=False, dry_run=False):
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    previous = signal.getsignal(signal.SIGTERM)
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        return await _produce(workspace, concurrency, repairs, only, overwrite, dry_run)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)
        signal.signal(signal.SIGTERM, previous)
