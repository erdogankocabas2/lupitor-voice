"""Identity verification.

The expected values never leave this module: tools receive only a status.
Two factors are required: date of birth plus either ZIP code (spoken) or the
last four SSN digits (keypad only, so they never pass through STT or the LLM).
"""
from __future__ import annotations

import hmac
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from .policy import Account

_DOB_FORMATS = (
    "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%m-%d-%Y", "%m.%d.%Y",
    "%B %d %Y", "%b %d %Y", "%d %B %Y", "%d %b %Y", "%B %Y %d",
)


def parse_dob(raw: str) -> Optional[date]:
    if not raw:
        return None
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", raw.strip(), flags=re.I)
    s = re.sub(r"[,]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    for fmt in _DOB_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def digits(raw: Optional[str]) -> str:
    return re.sub(r"\D", "", raw or "")


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


@dataclass
class VerificationResult:
    status: str  # "verified" | "failed" | "locked" | "invalid_input"
    attempts_left: int
    method: str


class Verifier:
    def __init__(self, account: Account, max_attempts: int = 3):
        self._account = account
        self._max = max_attempts
        self._failures = 0
        self.verified = False

    @property
    def locked(self) -> bool:
        return self._failures >= self._max

    def verify(self, dob_raw: str, zip_code: Optional[str] = None, ssn_last4: Optional[str] = None) -> VerificationResult:
        method = "dob+ssn4_keypad" if ssn_last4 else "dob+zip"
        if self.verified:
            return VerificationResult("verified", self._max - self._failures, method)
        if self.locked:
            return VerificationResult("locked", 0, method)

        dob = parse_dob(dob_raw)
        second = digits(ssn_last4) if ssn_last4 else digits(zip_code)[:5]
        if dob is None or not second:
            # Unparseable input does not burn an attempt, but tells the model to re-ask.
            return VerificationResult("invalid_input", self._max - self._failures, method)

        dob_ok = dob == self._account.dob
        if ssn_last4:
            second_ok = _eq(second, self._account.ssn_last4)
        else:
            second_ok = _eq(second, digits(self._account.zip_code)[:5])

        if dob_ok and second_ok:
            self.verified = True
            return VerificationResult("verified", self._max - self._failures, method)

        self._failures += 1
        status = "locked" if self.locked else "failed"
        return VerificationResult(status, self._max - self._failures, method)
