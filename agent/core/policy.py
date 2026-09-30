"""Deterministic offer engine.

The LLM never sees the settlement floor. It can only ask this engine for the
next approved offer, submit a customer's proposal for evaluation, or commit an
offer *by id*. Amounts are never passed in on commit, so there is no argument
the model (or a caller manipulating the model) can inflate or deflate.
"""
from __future__ import annotations

import math
import secrets
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, ROUND_UP, Decimal
from typing import Optional

CENT = Decimal("0.01")


def money(value) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def fmt(value: Decimal) -> str:
    return f"${value:,.2f}"


class PolicyViolation(Exception):
    """Raised when something tries to commit an arrangement the policy forbids."""


@dataclass(frozen=True)
class Account:
    id: str
    full_name: str
    phone: str
    dob: date
    zip_code: str
    ssn_last4: str
    account_last4: str
    balance: Decimal
    days_past_due: int
    portfolio: str
    product: str = "credit card"
    timezone: str = "America/New_York"

    @property
    def first_name(self) -> str:
        return self.full_name.split()[0]


@dataclass(frozen=True)
class Policy:
    portfolio: str
    ladder_pct: tuple[Decimal, ...]
    max_concessions_per_call: int
    plan_max_months: int
    plan_min_installment: Decimal
    plan_total_pct: Decimal
    first_payment_within_days: int = 14

    def __post_init__(self):
        ladder = self.ladder_pct
        if not ladder:
            raise ValueError("ladder_pct must not be empty")
        if any(b > a for a, b in zip(ladder, ladder[1:])):
            raise ValueError("ladder_pct must be non-increasing")
        if ladder[0] > 1 or ladder[-1] <= 0:
            raise ValueError("ladder_pct values must be in (0, 1]")
        if self.plan_total_pct < ladder[-1]:
            raise ValueError("plan_total_pct cannot be below the settlement floor")


@dataclass(frozen=True)
class Offer:
    offer_id: str
    kind: str  # "full" | "settlement" | "plan"
    total: Decimal
    installments: int
    installment_amount: Decimal
    last_installment_amount: Decimal
    first_due: date

    def describe(self) -> str:
        if self.kind == "plan":
            tail = ""
            if self.last_installment_amount != self.installment_amount:
                tail = f" (final payment {fmt(self.last_installment_amount)})"
            return (
                f"offer_id={self.offer_id}: payment plan of {self.installments} monthly payments of "
                f"{fmt(self.installment_amount)}{tail}, total {fmt(self.total)}, first payment due "
                f"{self.first_due:%B} {self.first_due.day}"
            )
        label = "pay the full balance" if self.kind == "full" else "one-time settlement"
        return (
            f"offer_id={self.offer_id}: {label} of {fmt(self.total)}, due by "
            f"{self.first_due:%B} {self.first_due.day}"
        )

    def amounts(self) -> set[Decimal]:
        return {self.total, self.installment_amount, self.last_installment_amount}


class OfferEngine:
    def __init__(self, account: Account, policy: Policy, today: Optional[date] = None):
        if account.portfolio != policy.portfolio:
            raise ValueError("policy does not match account portfolio")
        self._account = account
        self._policy = policy
        self._today = today or date.today()
        self._rung = 0
        self._concessions = 0
        self._issued: dict[str, Offer] = {}
        self._rung_offers: dict[int, Offer] = {}
        self._committed: Optional[Offer] = None

    # ---- internal -------------------------------------------------------
    @property
    def _floor(self) -> Decimal:
        return money(self._account.balance * self._policy.ladder_pct[-1])

    def _due(self) -> date:
        return self._today + timedelta(days=self._policy.first_payment_within_days)

    def _issue(self, kind: str, total: Decimal, installments: int = 1) -> Offer:
        total = money(total)
        if installments == 1:
            inst = last = total
        else:
            inst = (total / installments).quantize(CENT, rounding=ROUND_UP)
            last = total - inst * (installments - 1)
        offer = Offer(
            offer_id=f"OF-{secrets.token_hex(3).upper()}",
            kind=kind,
            total=total,
            installments=installments,
            installment_amount=inst,
            last_installment_amount=last,
            first_due=self._due(),
        )
        self._issued[offer.offer_id] = offer
        return offer

    def _rung_offer(self) -> Offer:
        if self._rung not in self._rung_offers:
            pct = self._policy.ladder_pct[self._rung]
            kind = "full" if pct >= 1 else "settlement"
            self._rung_offers[self._rung] = self._issue(kind, self._account.balance * pct)
        return self._rung_offers[self._rung]

    # ---- public API used by tools ----------------------------------------
    @property
    def committed(self) -> Optional[Offer]:
        return self._committed

    def current_offer(self) -> Offer:
        return self._rung_offer()

    def next_offer(self) -> Optional[Offer]:
        """Step one rung down the approved ladder. Returns None when no further
        concession is allowed on this call. Never goes below the last rung."""
        last_rung = len(self._policy.ladder_pct) - 1
        if self._rung >= last_rung or self._concessions >= self._policy.max_concessions_per_call:
            return None
        self._rung += 1
        self._concessions += 1
        return self._rung_offer()

    def evaluate_proposal(self, amount) -> tuple[bool, Offer]:
        """Accept a customer's lump-sum proposal only if it meets the offer
        currently on the table. A lower proposal is rejected *without* moving
        the ladder, so probing different numbers reveals nothing about the floor."""
        amount = money(amount)
        if amount >= self._account.balance:
            return True, self._issue("full", self._account.balance)
        current = self._rung_offer()
        if amount >= current.total:
            return True, self._issue("settlement", amount)
        return False, current

    def payment_plan(self, months: int) -> tuple[Optional[Offer], str]:
        p = self._policy
        total = money(self._account.balance * p.plan_total_pct)
        max_by_min = int(math.floor(total / p.plan_min_installment))
        max_months = max(1, min(p.plan_max_months, max_by_min))
        if months < 2:
            return None, "A plan needs at least 2 monthly payments; for one payment use the full-balance or settlement offer."
        if months > max_months:
            return None, f"The longest plan available on this account is {max_months} months."
        return self._issue("plan", total, months), "ok"

    def commit(self, offer_id: str) -> Offer:
        if self._committed is not None:
            raise PolicyViolation("an arrangement was already committed on this call")
        offer = self._issued.get(offer_id)
        if offer is None:
            raise PolicyViolation(f"unknown offer_id {offer_id!r}; only engine-issued offers can be committed")
        # Belt and braces: re-check the floor even though issuance already guarantees it.
        if offer.total < self._floor:
            raise PolicyViolation("offer total is below the approved floor")
        self._committed = offer
        return offer

    def allowed_amounts(self) -> set[Decimal]:
        """Every dollar figure the agent is permitted to say out loud."""
        amounts = {money(self._account.balance)}
        for offer in self._issued.values():
            amounts |= offer.amounts()
        return amounts

    def floor_for_audit(self) -> Decimal:
        """Only used by offline scoring (red team). Never exposed to a tool."""
        return self._floor
