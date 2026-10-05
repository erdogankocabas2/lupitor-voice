from __future__ import annotations

import asyncio
from typing import Optional


class KeypadBuffer:
    """Collects DTMF digits (phone) or keypad data messages (browser test page).
    Digits go straight to the verifier and never enter the LLM context."""

    def __init__(self) -> None:
        self._digits: list[str] = []
        self._done = asyncio.Event()

    def push(self, key: str) -> None:
        if not key:
            return
        for ch in str(key):
            if ch == "#":
                self._done.set()
            elif ch.isdigit():
                self._digits.append(ch)
                if len(self._digits) > 16:
                    self._digits = self._digits[-16:]
                if len(self._digits) >= 4:
                    self._done.set()

    def clear(self) -> None:
        self._digits.clear()
        self._done.clear()

    async def collect(self, n: int = 4, timeout: float = 25.0) -> Optional[str]:
        # If we already have >= n digits buffered (e.g. user entered digits during prompt),
        # return the latest n digits immediately without blocking or timing out.
        if len(self._digits) >= n:
            val = "".join(self._digits[-n:])
            self._digits.clear()
            self._done.clear()
            return val

        self._done.clear()
        try:
            while len(self._digits) < n:
                await asyncio.wait_for(self._done.wait(), timeout)
                if len(self._digits) >= n:
                    break
                self._done.clear()
        except (asyncio.TimeoutError, Exception):
            pass

        if len(self._digits) >= n:
            val = "".join(self._digits[-n:])
            self._digits.clear()
            self._done.clear()
            return val
        return None
