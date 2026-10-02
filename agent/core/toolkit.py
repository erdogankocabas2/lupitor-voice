"""CollectionsToolkit: all tool behaviour for the collection flow.

Both the LiveKit voice agent and the text-mode red-team harness call these
methods, so what we test is exactly what runs on the phone. Every method
returns text meant for the LLM; anything that must be said verbatim is
returned separately as a script.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Callable, Optional

from . import prompts
from .config import AgentConfig
from .policy import Account, Offer, OfferEngine, Policy, PolicyViolation, fmt
from .verification import Verifier

Emit = Callable[[str, dict], None]

ESCALATION_REASONS = tuple(prompts.ESCALATION_SCRIPTS.keys())


@dataclass
class ToolResult:
    message: str                      # returned to the LLM
    script: Optional[str] = None      # spoken verbatim by the runtime, if set
    end_call: bool = False            # runtime should hang up after the script
    handoff: Optional[str] = None     # "negotiation" when verification succeeds
    transfer: bool = False            # runtime should transfer to a human if configured


@dataclass
class CallOutcome:
    outcome: str = "in_progress"
    escalation: Optional[str] = None
    arrangement: Optional[Offer] = None
    notes: list[str] = field(default_factory=list)


class CollectionsToolkit:
    def __init__(
        self,
        cfg: AgentConfig,
        account: Optional[Account],
        load_policy: Callable[[str], Policy],
        find_account: Callable[[str], Optional[Account]],
        emit: Emit,
        today: Optional[date] = None,
        get_active_arrangement: Optional[Callable[[str], Optional[dict]]] = None,
    ):
        self.cfg = cfg
        self.account = account
        self._load_policy = load_policy
        self._find_account = find_account
        self._emit = emit
        self._today = today
        self._get_active_arrangement = get_active_arrangement
        self.verifier = Verifier(account) if account else None
        self.engine: Optional[OfferEngine] = None
        self.result = CallOutcome()
        self._lookups = 0

    # ---- state --------------------------------------------------------------
    @property
    def verified(self) -> bool:
        return bool(self.verifier and self.verifier.verified)

    def allowed_amounts(self) -> set[Decimal]:
        return self.engine.allowed_amounts() if self.engine else set()

    def _set_outcome(self, outcome: str) -> None:
        self.result.outcome = outcome
        self._emit("state", {"outcome": outcome})

    # ---- identification & verification --------------------------------------
    def lookup_account(self, phone_number: str) -> ToolResult:
        if self.account:
            return ToolResult("The account is already identified. Continue with verification.")
        self._lookups += 1
        if self._lookups > 3:
            return ToolResult("Too many lookups. Apologize and end the call with end_call(outcome='not_found').")
        acct = self._find_account(phone_number)
        self._emit("verification", {"step": "lookup", "found": bool(acct)})
        if not acct:
            return ToolResult("No account found for that number. Ask them to repeat the number on the account once more.")
        self.account = acct
        self.verifier = Verifier(acct)
        return ToolResult("Account located. Now verify identity with date of birth plus ZIP code or keypad SSN digits.")

    def verify_identity(self, date_of_birth: str, zip_code: Optional[str] = None, ssn_last4: Optional[str] = None) -> ToolResult:
        if not self.verifier:
            return ToolResult("No account identified yet. Use lookup_account first.")
        res = self.verifier.verify(date_of_birth, zip_code=zip_code, ssn_last4=ssn_last4)
        self._emit("verification", {"step": "verify", "status": res.status, "method": res.method, "attempts_left": res.attempts_left})
        if res.status == "verified":
            self.engine = OfferEngine(self.account, self._load_policy(self.account.portfolio), today=self._today)
            existing = self._get_active_arrangement(self.account.id) if (self._get_active_arrangement and self.account) else None
            if existing:
                script = (
                    f"Thank you, you're verified. {self.cfg.company} is a creditor and this is an attempt to collect a debt. "
                    f"Our records show an active payment arrangement is already established for your {self.account.product} "
                    f"with reference {existing.get('offer_id')}, for a total of {fmt(Decimal(str(existing.get('total'))))}. "
                    "This existing arrangement is currently active. If you have questions or need to make a payment, "
                    "I can connect you with a representative."
                )
                return ToolResult(
                    "Customer has an active arrangement already in effect. Advise them and transfer if requested.",
                    script=script,
                    handoff="negotiation",
                )
            return ToolResult(
                "Identity verified.",
                script=prompts.disclosure(self.cfg, self.account),
                handoff="negotiation",
            )
        if res.status == "locked":
            self._set_outcome("verification_failed")
            return ToolResult("Verification locked.", script=prompts.locked(self.cfg), end_call=True)
        if res.status == "invalid_input":
            return ToolResult("Could not understand the details. Ask again for the full date of birth (month, day, year) and the second item.")
        return ToolResult(
            f"Those details did not match. {res.attempts_left} attempt(s) left. Read back what you heard to confirm "
            "(for example: 'I heard ... for the ZIP code, could you please confirm or repeat your date of birth and billing ZIP code?') "
            "so the customer can correct any mistake, but do not state which item was incorrect."
        )

    def wrong_party(self, situation: str) -> ToolResult:
        if self.verifier:
            self.verifier.revoke()
        self.engine = None
        self._set_outcome(situation if situation in ("wrong_number", "not_available", "refused_to_verify") else "wrong_number")
        return ToolResult("Ending call politely.", script=prompts.wrong_party(self.cfg), end_call=True)

    def voicemail(self) -> ToolResult:
        self._set_outcome("voicemail")
        if not self.account:
            return ToolResult("Voicemail with unknown account; hang up.", end_call=True)
        return ToolResult("Leaving limited-content voicemail.", script=prompts.voicemail(self.cfg, self.account), end_call=True)

    # ---- negotiation ------------------------------------------------------------
    def _require_verified(self) -> Optional[ToolResult]:
        if not self.verified or not self.engine:
            self._emit("policy", {"action": "blocked_unverified_tool"})
            return ToolResult("Not permitted: identity is not verified.")
        return None

    def get_current_offer(self) -> ToolResult:
        if (blocked := self._require_verified()):
            return blocked
        offer = self.engine.current_offer()
        self._emit("policy", {"action": "current_offer", "offer_id": offer.offer_id, "kind": offer.kind, "total": str(offer.total)})
        return ToolResult(f"Current offer: {offer.describe()}.")

    def request_lower_settlement(self, customer_reason: str) -> ToolResult:
        if (blocked := self._require_verified()):
            return blocked
        offer = self.engine.next_offer()
        self._emit("policy", {"action": "request_lower", "reason": customer_reason[:200], "granted": bool(offer),
                              "offer_id": offer.offer_id if offer else None, "total": str(offer.total) if offer else None})
        if not offer:
            current = self.engine.current_offer()
            return ToolResult(
                f"No further reduction is available on this call. The best one-time offer remains {current.describe()}. "
                "Suggest a monthly payment plan instead."
            )
        return ToolResult(f"New approved offer: {offer.describe()}.")

    def evaluate_customer_offer(self, amount: float) -> ToolResult:
        if (blocked := self._require_verified()):
            return blocked
        try:
            accepted, offer = self.engine.evaluate_proposal(amount)
        except Exception:
            return ToolResult("That amount could not be read. Ask the customer to repeat it.")
        self._emit("policy", {"action": "evaluate_proposal", "proposed": str(amount), "accepted": accepted,
                              "offer_id": offer.offer_id, "total": str(offer.total)})
        if accepted:
            return ToolResult(
                f"Acceptable. Confirm with the customer, then commit: {offer.describe()}.",
                script=prompts.confirm_number_heard(offer.total),
            )
        return ToolResult(
            f"Not acceptable. Do not repeat or confirm the customer's number. The offer on the table is {offer.describe()}. "
            "Ask whether a monthly plan would be easier."
        )

    def propose_payment_plan(self, months: int) -> ToolResult:
        if (blocked := self._require_verified()):
            return blocked
        offer, note = self.engine.payment_plan(int(months))
        self._emit("policy", {"action": "payment_plan", "months": months, "offer_id": offer.offer_id if offer else None,
                              "total": str(offer.total) if offer else None, "note": note})
        if not offer:
            return ToolResult(f"Plan not available: {note}")
        return ToolResult(f"Approved plan: {offer.describe()}.")

    def confirm_arrangement(self, offer_id: str) -> ToolResult:
        if (blocked := self._require_verified()):
            return blocked
        existing = self._get_active_arrangement(self.account.id) if (self._get_active_arrangement and self.account) else None
        if existing:
            return ToolResult(
                f"An active arrangement (Reference {existing.get('offer_id')}) is already on record for this account. "
                "Multiple active arrangements are not permitted. Call escalate_to_human(reason='other', notes='Account already has active arrangement')."
            )
        try:
            offer = self.engine.commit(offer_id.strip().upper())
        except PolicyViolation as e:
            self._emit("policy", {"action": "commit_rejected", "offer_id": offer_id, "error": str(e)})
            return ToolResult(f"Rejected: {e}. Use an offer_id returned by a tool on this call.")
        self.result.arrangement = offer
        self._set_outcome("promise_to_pay")
        self._emit("arrangement", {"offer_id": offer.offer_id, "kind": offer.kind, "total": str(offer.total),
                                   "installments": offer.installments, "installment_amount": str(offer.installment_amount),
                                   "first_due": offer.first_due.isoformat()})
        return ToolResult(
            "Arrangement committed. The terms are being read to the customer verbatim. Afterwards ask if they have "
            "any questions, thank them, and call end_call(outcome='promise_to_pay').",
            script=prompts.readback(offer, self.account),
        )

    def revoke_verification(self, reason: str = "caller_is_third_party") -> ToolResult:
        if self.verifier:
            self.verifier.revoke()
        self.engine = None
        self._emit("verification", {"step": "revoked", "reason": reason})
        return ToolResult("Verification revoked. You must not disclose debt or negotiate.", handoff="verification")

    # ---- escalation & ending ---------------------------------------------------
    def escalate(self, reason: str, notes: str = "") -> ToolResult:
        reason = reason if reason in ESCALATION_REASONS else "other"
        notes_lower = (notes or "").lower()
        if any(w in notes_lower for w in ("third party", "third-party", "sister", "brother", "spouse", "husband", "wife", "not the account holder", "not account holder", "impostor", "someone else", "behalf", "relative")):
            if self.verifier:
                self.verifier.revoke()
            self.engine = None
        self.result.escalation = reason
        self._set_outcome(f"escalated_{reason}")
        self._emit("escalation", {"reason": reason, "notes": notes[:500]})
        script = prompts.ESCALATION_SCRIPTS[reason]
        transfer = reason in ("hardship", "requested_human", "other", "identity_theft", "crisis")
        return ToolResult("Escalation recorded.", script=script, end_call=True, transfer=transfer)

    def end_call(self, outcome: str) -> ToolResult:
        if self.result.outcome == "in_progress":
            self._set_outcome(outcome or "completed")
        return ToolResult("Ending call.", end_call=True)

    def summary(self) -> dict:
        a = self.result.arrangement
        return {
            "outcome": self.result.outcome,
            "verified": self.verified,
            "escalation": self.result.escalation,
            "arrangement": None if not a else {
                "offer_id": a.offer_id, "kind": a.kind, "total": str(a.total),
                "installments": a.installments, "installment_amount": str(a.installment_amount),
            },
        }
