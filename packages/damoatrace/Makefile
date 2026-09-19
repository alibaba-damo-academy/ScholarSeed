SHELL := /bin/bash
PYTHON ?= python3.12
VENV ?= .venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

.PHONY: install fmt fmt-check contract check wheel

$(PY):
	$(PYTHON) -m venv $(VENV)

install: $(PY)
	$(PIP) install -e ".[dev]"

fmt: install
	$(PY) -m isort damoatrace
	$(PY) -m black damoatrace

fmt-check: install
	$(PY) -m isort --check-only --diff damoatrace
	$(PY) -m black --check --diff damoatrace

contract: install
	$(PY) -m damoatrace.tests.contract_boundary
	$(PY) -m damoatrace.tests.contract_distribution
	$(PY) -m damoatrace.tests.e2e_trace_query_cli
	$(PY) -m damoatrace.tests.contract_offline
	$(PY) -m damoatrace.tests.contract_diagnostics
	$(PY) -m damoatrace.tests.contract_content
	$(PY) -m damoatrace.tests.contract_budget

check: fmt-check contract

wheel: install
	$(PY) -m build --wheel --outdir dist .
	$(PY) -m twine check dist/*.whl
