"""The deployment code itself: checks only, run by the workflow's verify job."""
from modules import VERIFY_JOB, Checks


class Deploy(Checks):
    job = VERIFY_JOB
