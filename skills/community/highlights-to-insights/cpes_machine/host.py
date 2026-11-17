"""Detect the client without exposing or depending on its private bridge keys."""
import os

from cpes.contracts import CpesError


HOST_ENV = ('SCHOLARSEED_SKILL_PYTHON', 'SCHOLARSEED_INTERNAL_BASE_URL',
            'SCHOLARSEED_BRIDGE_SOCKET', 'SCHOLARSEED_BRIDGE_TOKEN',
            'SCHOLARSEED_BRIDGE_SESSION')


def in_host():
    # Ordinary shell tools intentionally do not inherit private bridge secrets.
    # The public Skill Python launcher identifies this path without those keys.
    return any(name in os.environ for name in HOST_ENV)


def validate_options(model, profile):
    if in_host() and (model is not None or profile is not None):
        raise CpesError('host_model_override',
                        'Inside ScholarSeed, select the model in the client and prepare without --model/--profile.')
