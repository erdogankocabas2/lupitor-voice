"""Sentence-level output guard.

Runs on the LLM's text stream *before* it reaches TTS or the transcript.
Rules are deterministic: the model is probabilistic, the wording rules are not.

1. Before identity verification, no dollar amount and no debt vocabulary may be
   spoken (third-party disclosure).
2. After verification, the only dollar amounts that may be spoken are the ones
   the offer engine has issued (plus the balance itself).
3. Percentages are never spoken; offers are always stated in dollars.
4. Threats and pressure language are replaced, not merely discouraged.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Callable, Iterable

from .policy import money

# ---------------------------------------------------------------------------
# Amount extraction
# ---------------------------------------------------------------------------
_NUM = r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?"
_DOLLAR_SIGN = re.compile(r"\$\s?" + _NUM + r"(\s*(?:k|thousand|grand)\b)?", re.I)
_DOLLAR_WORD = re.compile(r"\b" + _NUM + r"\s*(k\s*|thousand\s*|grand\s*)?(?:dollars?|usd|bucks)\b", re.I)
_GRAND_WORD = re.compile(r"\b" + _NUM + r"\s*(?:grand|grands)\b", re.I)
_K_WORD = re.compile(r"\b" + _NUM + r"\s*k\b", re.I)
_PERCENT = re.compile(r"\b\d+(?:\.\d+)?\s*(?:%|percent\b)|\b(?:half|a quarter|a third)\s+(?:off|of (?:the|your) (?:balance|debt))", re.I)
FOREIGN_CURRENCY = re.compile(
    r"[\u20ac\u00a3\u20ba]\s?\d|\d[\d.,]*\s*(?:euros?|eur|lira|liras|tl|pounds?|gbp|d[o\u00f3]lares|pesos)\b"
    r"|\b(?:mil|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos)\b[^.]{0,40}\bd[o\u00f3]lares\b",
    re.I,
)

_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_SCALES = {"hundred": 100, "thousand": 1000, "grand": 1000}
_WORD = r"(?:" + "|".join(list(_UNITS) + list(_TENS) + list(_SCALES) + ["and", "a"]) + r")"
_WORD_AMOUNT = re.compile(r"\b((?:" + _WORD + r")(?:[\s-]+" + _WORD + r")*)\s+(?:dollars?|bucks|usd|grand)\b", re.I)


def _words_to_int(phrase: str) -> int | None:
    total, current, seen = 0, 0, False
    for tok in re.split(r"[\s-]+", phrase.lower()):
        if tok in ("and", ""):
            continue
        if tok == "a":
            current = max(current, 1)
            continue
        if tok in _UNITS:
            current += _UNITS[tok]
        elif tok in _TENS:
            current += _TENS[tok]
        elif tok == "hundred":
            current = max(current, 1) * 100
        elif tok in ("thousand", "grand"):
            total += max(current, 1) * 1000
            current = 0
        else:
            return None
        seen = True
    return total + current if seen else None


def extract_amounts(text: str) -> list[Decimal]:
    found: list[Decimal] = []
    for m in _DOLLAR_SIGN.finditer(text):
        found.append(_to_decimal(m.group(1), m.group(2), bool(m.group(3))))
    for m in _DOLLAR_WORD.finditer(text):
        found.append(_to_decimal(m.group(1), m.group(2), bool(m.group(3))))
    for m in _GRAND_WORD.finditer(text):
        found.append(_to_decimal(m.group(1), m.group(2), True))
    for m in _K_WORD.finditer(text):
        found.append(_to_decimal(m.group(1), m.group(2), True))
    for m in _WORD_AMOUNT.finditer(text):
        value = _words_to_int(m.group(1))
        if value is not None:
            found.append(money(value))
    # Deduplicate while preserving order
    seen_amounts = set()
    deduped = []
    for a in found:
        if a not in seen_amounts:
            seen_amounts.add(a)
            deduped.append(a)
    return deduped


def _to_decimal(whole: str, cents: str | None, thousands: bool) -> Decimal:
    try:
        value = Decimal(whole.replace(",", "") + ("." + cents if cents else ""))
    except InvalidOperation:
        return Decimal("-1")
    return money(value * 1000 if thousands else value)


# ---------------------------------------------------------------------------
# Wording rules (FDCPA, CFPB & Third-Party Privacy)
# ---------------------------------------------------------------------------
PROHIBITED = [
    # Criminal / arrest threats
    r"\barrest", r"\bjail\b", r"\bprison\b", r"\bpolice\b", r"\bcriminal\b", r"\bwarrant\b",
    # Asset seizure / legal action threats
    r"\bgarnish", r"\bseiz(?:e|ure)\b", r"\brepossess", r"\bsu(?:e|ing|ed)\b", r"\blawsuit\b",
    r"\blegal action\b", r"\btake (?:you )?to court\b", r"\bsummons\b", r"\bcourt order\b",
    # Deportation / intimidation / threats
    r"\bdeport", r"\bruin (?:your|their) (?:credit|life|score)\b", r"\byou(?:'ll| will) regret\b",
    r"\blast chance\b", r"\bor else\b",
    # Third party / employer / workplace harassment
    r"\b(?:call|contact|notify|tell) (?:your )?(?:employer|boss|hr|workplace|family|relatives|neighbou?rs)\b",
    r"\b(?:visit|send someone to) (?:your|their) (?:home|house|address|job)\b",
    # Credit scoring threats
    r"\b(?:damage|destroy|wreck|lower) (?:your )?credit\b",
    r"\breport (?:you |this )?to (?:the )?(?:credit bureau|equifax|experian|transunion)\b",
    # Abusive / derogatory language
    r"\bdeadbeat\b", r"\buntrustworthy\b", r"\birresponsible\b", r"\bliar\b",
]
_PROHIBITED = re.compile("|".join(PROHIBITED), re.I)

DISCLOSURE_TERMS = re.compile(
    r"\b(?:debt|balance|past[- ]due|overdue|owe[sd]?|owing|delinquen\w*|collections?|arrears|outstanding|"
    r"payment|late[- ]fee|interest charges?|default|credit limit|statement balance|loan amount)\b",
    re.I,
)

SAFE_PRE_VERIFICATION = (
    "I can only go into the details once I've confirmed I'm speaking with the right person. "
)
SAFE_AMOUNT = "I'm not able to agree to that amount. Let me know if you would like to review our approved settlement or monthly payment plan options. "
SAFE_PERCENT = "Let me provide you with the exact dollar figures instead. "
SAFE_PROHIBITED = "My goal is simply to work with you to find an agreeable solution for your account. "


@dataclass
class GuardDecision:
    ok: bool
    text: str
    original: str
    reasons: list[str] = field(default_factory=list)


class ResponseGuard:
    def __init__(
        self,
        allowed_amounts: Callable[[], Iterable[Decimal]],
        is_verified: Callable[[], bool],
    ):
        self._allowed = allowed_amounts
        self._verified = is_verified

    def check(self, sentence: str) -> GuardDecision:
        reasons: list[str] = []
        verified = self._verified()
        amounts = extract_amounts(sentence)

        if _PROHIBITED.search(sentence):
            reasons.append("prohibited_language")
        if FOREIGN_CURRENCY.search(sentence):
            reasons.append("unapproved_foreign_currency")
        if not verified:
            if amounts:
                reasons.append("amount_before_verification")
            if DISCLOSURE_TERMS.search(sentence):
                reasons.append("disclosure_before_verification")
        else:
            allowed = {money(a) for a in self._allowed()}
            unapproved = [a for a in amounts if a not in allowed]
            if unapproved:
                reasons.append("unapproved_amount:" + ",".join(str(a) for a in unapproved))
        if _PERCENT.search(sentence):
            reasons.append("percentage")

        if not reasons:
            return GuardDecision(ok=True, text=sentence, original=sentence)

        if "prohibited_language" in reasons:
            replacement = SAFE_PROHIBITED
        elif not verified:
            replacement = SAFE_PRE_VERIFICATION
        elif any(r.startswith("unapproved_amount") or r == "unapproved_foreign_currency" for r in reasons):
            replacement = SAFE_AMOUNT
        else:
            replacement = SAFE_PERCENT
        return GuardDecision(ok=False, text=replacement, original=sentence, reasons=reasons)


class SentenceBuffer:
    """Accumulates streamed text and releases complete sentences."""

    _END = re.compile(r"(?<=[.!?])(?:\s+|$)")

    def __init__(self) -> None:
        self._buf = ""

    def push(self, text: str) -> list[str]:
        self._buf += text
        out: list[str] = []
        while True:
            m = self._END.search(self._buf)
            # Avoid splitting "$4,120.60" or "e.g." mid-number: require the char
            # after the terminator to be whitespace (handled by regex) and the
            # terminator not to sit between digits.
            if not m or m.end() == len(self._buf) and not self._buf.endswith((" ", "\n")):
                break
            cut = m.end()
            out.append(self._buf[:cut])
            self._buf = self._buf[cut:]
        return out

    def flush(self) -> str:
        tail, self._buf = self._buf, ""
        return tail
