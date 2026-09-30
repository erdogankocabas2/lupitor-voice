from __future__ import annotations

from livekit.agents import Agent, RunContext, function_tool

from core import prompts
from core.config import AgentConfig
from core.db import EventSink

from .collections import hang_up


class GenericAgent(Agent):
    """Any agent created in the UI with the 'generic' template: persona, greeting
    and instructions come entirely from the versioned config."""

    def __init__(self, cfg: AgentConfig, sink: EventSink, greet: bool = True):
        super().__init__(instructions=prompts.generic_instructions(cfg))
        self.cfg = cfg
        self.sink = sink
        self._greet_on_enter = greet

    async def on_enter(self):
        if self._greet_on_enter:
            await self.greet()

    async def greet(self):
        if self.cfg.greeting:
            self.session.say(self.cfg.greeting)
        else:
            self.session.generate_reply(instructions="Greet the caller briefly and ask how you can help.")

    @function_tool()
    async def end_call(self, context: RunContext, outcome: str = "completed"):
        """End the call after saying goodbye.

        Args:
            outcome: Short outcome label.
        """
        self.sink.emit("state", {"outcome": outcome})
        await context.wait_for_playout()
        await hang_up()
        return None
