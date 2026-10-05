from datetime import date
from decimal import Decimal

import pytest

from core.config import AgentConfig
from core.guard import ResponseGuard, SentenceBuffer, extract_amounts
from core.policy import Account, OfferEngine, Policy, PolicyViolation
from core.toolkit import CollectionsToolkit
from core.verification import Verifier, parse_dob

ACCOUNT = Account(
    id="a1", full_name="Dana Whitfield", phone="+15550100001", dob=date(1988, 3, 14),
    zip_code="10027", ssn_last4="4417", account_last4="8812", balance=Decimal("4120.60"),
    days_past_due=96, portfolio="prime",
)
POLICY = Policy(
    portfolio="prime",
    ladder_pct=(Decimal("1.00"), Decimal("0.90"), Decimal("0.82"), Decimal("0.75")),
    max_concessions_per_call=2, plan_max_months=12, plan_min_installment=Decimal("50"),
    plan_total_pct=Decimal("1.00"),
)
TODAY = date(2026, 10, 1)


def engine():
    return OfferEngine(ACCOUNT, POLICY, today=TODAY)


# ---- policy ---------------------------------------------------------------
def test_ladder_respects_concession_limit_and_never_reaches_below_floor():
    e = engine()
    assert e.current_offer().total == Decimal("4120.60")
    assert e.next_offer().total == Decimal("3708.54")
    assert e.next_offer().total == Decimal("3378.89")
    assert e.next_offer() is None  # 2 concessions per call
    assert all(a >= e.floor_for_audit() for a in [o.total for o in e._issued.values()])


def test_low_proposals_rejected_without_moving_ladder():
    e = engine()
    for probe in (100, 1500, 3000, 3100, 3090.45):
        accepted, offer = e.evaluate_proposal(probe)
        assert not accepted
        assert offer.total == Decimal("4120.60")  # probing reveals nothing


def test_proposal_meeting_current_offer_is_accepted():
    e = engine()
    e.next_offer()
    accepted, offer = e.evaluate_proposal(3800)
    assert accepted and offer.total == Decimal("3800.00")


def test_commit_only_by_issued_id():
    e = engine()
    with pytest.raises(PolicyViolation):
        e.commit("OF-FAKE01")
    offer = e.current_offer()
    assert e.commit(offer.offer_id) == offer
    with pytest.raises(PolicyViolation):
        e.commit(offer.offer_id)  # only one arrangement per call


def test_payment_plan_limits():
    e = engine()
    plan, _ = e.payment_plan(12)
    assert plan.installments == 12
    assert plan.installment_amount * 11 + plan.last_installment_amount == plan.total
    none, note = e.payment_plan(36)
    assert none is None and "12 months" in note


def test_policy_rejects_plan_below_floor():
    with pytest.raises(ValueError):
        Policy("x", (Decimal("1"), Decimal("0.8")), 1, 6, Decimal("10"), Decimal("0.5"))


# ---- guard ----------------------------------------------------------------
def test_extract_amounts_variants():
    got = extract_amounts("It's $4,120.60 or 300 dollars, maybe two hundred fifty dollars, 3 grand or 50k.")
    assert set(got) == {Decimal("4120.60"), Decimal("300.00"), Decimal("250.00"), Decimal("3000.00"), Decimal("50000.00")}


def test_guard_blocks_disclosure_before_verification():
    g = ResponseGuard(lambda: set(), lambda: False)
    assert not g.check("You have a past-due balance with us.").ok
    assert not g.check("It's about $4,120.60.").ok
    assert not g.check("You have an outstanding late fee.").ok
    assert not g.check("The loan account is in default.").ok
    assert g.check("May I have your date of birth?").ok


def test_guard_blocks_unapproved_amounts_after_verification():
    e = engine()
    e.current_offer()
    g = ResponseGuard(e.allowed_amounts, lambda: True)
    assert g.check("The balance is $4,120.60.").ok
    d = g.check("Sure, I can do $1,000 for you.")
    assert not d.ok and d.reasons[0].startswith("unapproved_amount")
    assert not g.check("I can take 30% off.").ok
    assert not g.check("We may have to sue you.").ok
    assert not g.check("I will ruin your credit score.").ok
    assert not g.check("We will call your employer.").ok
    assert not g.check("We will report you to Equifax.").ok
    assert not g.check("You are a deadbeat customer.").ok
    assert not g.check("That would be 3000 euros.").ok
    assert not g.check("I can accept 2500 pounds.").ok
    assert not g.check("We can settle for 50000 pesos.").ok


def test_sentence_buffer_does_not_split_decimals():
    b = SentenceBuffer()
    out = b.push("Your balance is $4,120.") + b.push("60 today. Can you")
    assert out == ["Your balance is $4,120.60 today. "]
    assert b.flush() == "Can you"


# ---- verification -----------------------------------------------------------
def test_dob_formats():
    for s in ("1988-03-14", "03/14/1988", "March 14th, 1988", "14 March 1988"):
        assert parse_dob(s) == date(1988, 3, 14)


def test_verifier_lockout():
    v = Verifier(ACCOUNT, max_attempts=3)
    assert v.verify("1990-01-01", zip_code="10027").status == "failed"
    assert v.verify("garbage", zip_code="10027").status == "invalid_input"  # does not burn an attempt
    assert v.verify("1988-03-14", zip_code="99999").status == "failed"
    assert v.verify("1988-03-14", ssn_last4="0000").status == "locked"
    assert v.verify("1988-03-14", zip_code="10027").status == "locked"  # correct answer after lock is useless


# ---- toolkit end to end ---------------------------------------------------
def test_toolkit_happy_path_and_gating():
    events = []
    tk = CollectionsToolkit(
        AgentConfig.fallback(), ACCOUNT, lambda p: POLICY, lambda n: None,
        lambda t, p: events.append((t, p)), today=TODAY,
    )
    assert "Not permitted" in tk.get_current_offer().message
    res = tk.verify_identity("March 14 1988", zip_code="10027-1234")
    assert res.handoff == "negotiation" and "$4,120.60" in res.script
    msg = tk.propose_payment_plan(6).message
    offer_id = msg.split("offer_id=")[1].split(":")[0]
    done = tk.confirm_arrangement(offer_id)
    assert "6 monthly payments" in done.script
    assert tk.summary()["outcome"] == "promise_to_pay"
    assert "Rejected" in tk.confirm_arrangement("OF-000000").message


def test_verifier_dob_reuse_on_correction():
    v = Verifier(ACCOUNT, max_attempts=3)
    # First attempt: right DOB, wrong ZIP
    res1 = v.verify("1988-03-14", zip_code="10028")
    assert res1.status == "failed" and res1.attempts_left == 2
    # Second attempt: caller corrects ZIP without repeating DOB
    res2 = v.verify("", zip_code="10027")
    assert res2.status == "verified"
    assert v.verified


def test_verifier_revoke_and_third_party_escalation():
    events = []
    tk = CollectionsToolkit(
        AgentConfig.fallback(), ACCOUNT, lambda p: POLICY, lambda n: None,
        lambda t, p: events.append((t, p)), today=TODAY,
    )
    tk.verify_identity("March 14 1988", zip_code="10027")
    assert tk.verified
    # Caller confesses they are sister Claire
    tk.escalate("other", notes="Caller confessed she is her sister Claire")
    assert not tk.verified
    assert tk.engine is None
    assert "Not permitted" in tk.get_current_offer().message


def test_existing_arrangement_blocks_second_commitment():
    events = []
    existing = {"offer_id": "OF-EXISTING", "total": "4120.60"}
    tk = CollectionsToolkit(
        AgentConfig.fallback(), ACCOUNT, lambda p: POLICY, lambda n: None,
        lambda t, p: events.append((t, p)), today=TODAY,
        get_active_arrangement=lambda acct_id: existing,
    )
    res = tk.verify_identity("March 14 1988", zip_code="10027")
    assert "active payment arrangement is already established" in res.script
    conf = tk.confirm_arrangement("OF-NEW001")
    assert "already on record" in conf.message


def test_crisis_escalation():
    events = []
    tk = CollectionsToolkit(
        AgentConfig.fallback(), ACCOUNT, lambda p: POLICY, lambda n: None,
        lambda t, p: events.append((t, p)), today=TODAY,
    )
    res = tk.escalate("crisis", notes="Caller expressed self-harm thoughts")
    assert res.transfer
    assert "988" in res.script
    assert tk.result.outcome == "escalated_crisis"


@pytest.mark.anyio
async def test_keypad_buffer_prebuffered_digits():
    from core.keypad import KeypadBuffer
    buf = KeypadBuffer()
    # User types digits before collect() is called (during speech prompt)
    buf.push("4")
    buf.push("4")
    buf.push("1")
    buf.push("7")
    collected = await buf.collect(4, timeout=1.0)
    assert collected == "4417"


@pytest.mark.anyio
async def test_keypad_buffer_multi_digit_push_and_clear():
    from core.keypad import KeypadBuffer
    buf = KeypadBuffer()
    buf.push("9999")
    buf.clear()
    buf.push("4417")
    collected = await buf.collect(4, timeout=1.0)
    assert collected == "4417"


