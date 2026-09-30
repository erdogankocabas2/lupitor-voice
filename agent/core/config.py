from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

DEFAULT_VOICE = "cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
DEFAULT_LLM = "openai/gpt-4.1-mini"
DEFAULT_STT = "deepgram/nova-3:en"


@dataclass
class AgentConfig:
    agent_id: Optional[str]
    version_id: Optional[str]
    version: int
    template: str  # "collections" | "generic"
    persona_name: str = "Alex"
    company: str = "Goldman Stanley"
    callback_number: str = "+1 555 010 0199"
    llm: str = DEFAULT_LLM
    stt: str = DEFAULT_STT
    tts: str = DEFAULT_VOICE
    extra_instructions: str = ""
    greeting: str = ""

    @classmethod
    def from_row(cls, version_row: dict[str, Any], template: str) -> "AgentConfig":
        c = version_row.get("config") or {}
        return cls(
            agent_id=version_row.get("agent_id"),
            version_id=version_row.get("id"),
            version=int(version_row.get("version") or 0),
            template=template,
            persona_name=c.get("persona_name") or "Alex",
            company=c.get("company") or "Goldman Stanley",
            callback_number=c.get("callback_number") or "+1 555 010 0199",
            llm=c.get("llm") or DEFAULT_LLM,
            stt=c.get("stt") or DEFAULT_STT,
            tts=c.get("tts") or DEFAULT_VOICE,
            extra_instructions=c.get("extra_instructions") or "",
            greeting=c.get("greeting") or "",
        )

    @classmethod
    def fallback(cls) -> "AgentConfig":
        return cls(agent_id=None, version_id=None, version=0, template="collections")
