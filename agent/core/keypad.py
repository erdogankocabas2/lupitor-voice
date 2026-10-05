from __future__ import annotations

import asyncio
from typing import Optional


class KeypadBuffer:
    """Collects DTMF digits (phone) or keypad data messages (browser test page).
    Digits go straight to the verifier and never enter the LLM context."""

    def __init__(self) -> None:
        self._digits: list[str] = []
        self._done = asyncio.Event()
        self._active: bool = False

    def start_collecting(self) -> None:
        """Called when the agent begins asking for keypad input.
        Clears pre-existing stray clicks and activates digit recording."""
        self._digits.clear()
        self._done.clear()
        self._active = True

    def push(self, key: str) -> None:
        if not key or not self._active:
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
        # If we already have >= n digits buffered (e.g. user started typing during prompt playout),
        # return immediately without timeout.
        if len(self._digits) >= n:
            val = "".join(self._digits[:n])
            self._digits = self._digits[n:]
            self._active = False
            self._done.clear()
            return val

        self._done.clear()
        try:
            while len(self._digits) < n:
                await asyncio.wait_for(self._done.wait(), timeout)
                if len(self._digits) >= n or self._done.is_set():
                    break
                self._done.clear()
        except (asyncio.TimeoutError, Exception):
            pass
        finally:
            self._active = False

        if len(self._digits) >= n:
            val = "".join(self._digits[:n])
            self._digits = self._digits[n:]
            self._done.clear()
            return val
        elif len(self._digits) > 0 and self._done.is_set():
            # In case caller pressed '#' after entering 4 or 5 digits
            val = "".join(self._digits)
            self._digits.clear()
            self._done.clear()
            return val
        return None
