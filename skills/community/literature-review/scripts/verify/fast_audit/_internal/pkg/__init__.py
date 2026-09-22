"""Fast-Audit isolated runtime package.

This package is the private implementation of the 6 fast-audit modules. The
fast-audit subagent must NOT read this directory directly; it interacts only
through the CLI declared in ../runtime/cli.py.

All modules here are self-contained — no imports from the surrounding Verifier
project (modules/, mcp_server/, utils/).
"""
