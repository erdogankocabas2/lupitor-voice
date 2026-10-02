"""Data access (Supabase / Postgres) and a non-blocking event sink.

Database writes never run on the audio path: events are queued and flushed in
batches from a background task, so a slow insert cannot add latency to a turn.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from .policy import Account, Policy

log = logging.getLogger("db")


def _account(row: dict) -> Account:
    return Account(
        id=row["id"], full_name=row["full_name"], phone=row["phone"],
        dob=date.fromisoformat(row["dob"]), zip_code=row["zip_code"], ssn_last4=row["ssn_last4"],
        account_last4=row["account_last4"], balance=Decimal(str(row["balance"])),
        days_past_due=int(row["days_past_due"]), portfolio=row["portfolio"],
        product=row.get("product") or "credit card", timezone=row.get("timezone") or "America/New_York",
    )


def _policy(row: dict) -> Policy:
    return Policy(
        portfolio=row["portfolio"],
        ladder_pct=tuple(Decimal(str(x)) for x in row["ladder_pct"]),
        max_concessions_per_call=int(row["max_concessions_per_call"]),
        plan_max_months=int(row["plan_max_months"]),
        plan_min_installment=Decimal(str(row["plan_min_installment"])),
        plan_total_pct=Decimal(str(row["plan_total_pct"])),
        first_payment_within_days=int(row.get("first_payment_within_days") or 14),
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_phone(p: str) -> str:
    digits = "".join(ch for ch in (p or "") if ch.isdigit())
    return "+" + digits if digits else ""


class Database:
    def __init__(self, client):
        self._c = client

    @classmethod
    def from_env(cls) -> "Database":
        from supabase import create_client  # imported lazily so unit tests need no network deps

        return cls(create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]))

    # ---- reads -------------------------------------------------------------
    def get_agent(self, agent_id: str) -> Optional[dict]:
        r = self._c.table("agents").select("*").eq("id", agent_id).limit(1).execute()
        return r.data[0] if r.data else None

    def get_inbound_agent(self) -> Optional[dict]:
        r = (self._c.table("agents").select("*").eq("handles_inbound", True)
             .is_("archived_at", "null").order("created_at", desc=True).limit(1).execute())
        return r.data[0] if r.data else None

    def get_version(self, version_id: str) -> Optional[dict]:
        r = self._c.table("agent_versions").select("*").eq("id", version_id).limit(1).execute()
        return r.data[0] if r.data else None

    def pick_version(self, agent_id: str) -> Optional[dict]:
        """Weighted pick across live versions (traffic split / A-B test)."""
        r = self._c.table("agent_versions").select("*").eq("agent_id", agent_id).gt("traffic_weight", 0).execute()
        rows = r.data or []
        if not rows:
            r = (self._c.table("agent_versions").select("*").eq("agent_id", agent_id)
                 .order("version", desc=True).limit(1).execute())
            return r.data[0] if r.data else None
        return random.choices(rows, weights=[row["traffic_weight"] for row in rows], k=1)[0]

    def get_account(self, account_id: str) -> Optional[Account]:
        r = self._c.table("accounts").select("*").eq("id", account_id).limit(1).execute()
        return _account(r.data[0]) if r.data else None

    def find_account_by_phone(self, phone: str) -> Optional[Account]:
        p = normalize_phone(phone)
        if not p:
            return None
        r = self._c.table("accounts").select("*").eq("phone", p).limit(1).execute()
        return _account(r.data[0]) if r.data else None

    def get_policy(self, portfolio: str) -> Policy:
        r = self._c.table("offer_policies").select("*").eq("portfolio", portfolio).limit(1).execute()
        if not r.data:
            raise LookupError(f"no offer policy for portfolio {portfolio}")
        return _policy(r.data[0])

    def get_active_arrangement(self, account_id: str) -> Optional[dict]:
        r = (self._c.table("arrangements").select("*").eq("account_id", account_id)
             .order("created_at", desc=True).limit(1).execute())
        return r.data[0] if r.data else None

    def has_active_arrangement(self, account_id: str) -> bool:
        r = (self._c.table("arrangements").select("id").eq("account_id", account_id)
             .limit(1).execute())
        return bool(r.data)

    def can_contact(self, account_id: str) -> tuple[bool, str]:
        r = self._c.rpc("can_contact", {"p_account_id": account_id}).execute()
        row = (r.data or [{}])[0]
        return bool(row.get("allowed")), row.get("reason") or "unknown"

    def list_events(self, call_id: str) -> list[dict]:
        r = self._c.table("call_events").select("*").eq("call_id", call_id).order("id").execute()
        return r.data or []

    # ---- writes ------------------------------------------------------------
    def create_call(self, **fields: Any) -> str:
        r = self._c.table("calls").insert(fields).execute()
        return r.data[0]["id"]

    def update_call(self, call_id: str, **fields: Any) -> None:
        self._c.table("calls").update(fields).eq("id", call_id).execute()

    def insert_events(self, rows: list[dict]) -> None:
        if rows:
            self._c.table("call_events").insert(rows).execute()

    def insert_arrangement(self, **fields: Any) -> None:
        self._c.table("arrangements").insert(fields).execute()

    def insert_redteam_run(self, **fields: Any) -> None:
        self._c.table("redteam_runs").insert(fields).execute()


class EventSink:
    """Queue events from sync callbacks; flush from one background task."""

    def __init__(self, db: Optional[Database], call_id: Optional[str] = None, flush_every: float = 1.0):
        self.db = db
        self.call_id = call_id
        self._q: asyncio.Queue[dict] = asyncio.Queue()
        self._every = flush_every
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    def emit(self, type_: str, payload: dict) -> None:
        log.info("event %s %s", type_, payload)
        self._q.put_nowait({"type": type_, "payload": payload, "ts": now_iso()})

    async def _drain(self) -> None:
        rows = []
        while not self._q.empty():
            ev = self._q.get_nowait()
            rows.append({"call_id": self.call_id, **ev})
        if rows and self.db and self.call_id:
            try:
                await asyncio.to_thread(self.db.insert_events, rows)
            except Exception:
                log.exception("failed to write %d events", len(rows))

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._every)
            await self._drain()

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
        await self._drain()
