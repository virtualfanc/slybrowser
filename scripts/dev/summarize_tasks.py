#!/usr/bin/env python3
"""Summarize checkbox task state in the SlyBrowser delivery tracker.

The tracker intentionally keeps external blockers as ``[!]`` rather than
marking partially implemented production work complete. This helper preserves
that distinction and prints a compact section-level view for local handoff.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path


CHECKBOX_RE = re.compile(r"^\s*-\s+\[(?P<state>x|X| |!)\]\s+(?P<title>.*)$")
HEADING_RE = re.compile(r"^(?P<marks>#{1,6})\s+(?P<title>.+?)\s*$")


STATE_LABELS = {
    "x": "complete",
    " ": "pending",
    "!": "external",
}


@dataclass(frozen=True)
class Task:
    state: str
    title: str
    section: str
    line: int


def parse_tasks(path: Path) -> list[Task]:
    section_stack: dict[int, str] = {}
    tasks: list[Task] = []

    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group("marks"))
            section_stack[level] = heading.group("title").strip()
            for stale_level in [candidate for candidate in section_stack if candidate > level]:
                del section_stack[stale_level]
            continue

        checkbox = CHECKBOX_RE.match(line)
        if not checkbox:
            continue

        raw_state = checkbox.group("state").lower()
        section = section_stack.get(max(section_stack, default=1), "(root)")
        tasks.append(
            Task(
                state=STATE_LABELS[raw_state],
                title=checkbox.group("title").strip(),
                section=section,
                line=line_number,
            )
        )

    return tasks


def print_summary(tasks: list[Task], show_pending: bool) -> None:
    totals = Counter(task.state for task in tasks)
    completed = totals["complete"]
    pending = totals["pending"]
    external = totals["external"]
    total = completed + pending + external

    print(f"total={total} complete={completed} pending={pending} external={external}")

    by_section: dict[str, Counter[str]] = defaultdict(Counter)
    for task in tasks:
        by_section[task.section][task.state] += 1

    for section in sorted(by_section):
        section_counts = by_section[section]
        if not show_pending and section_counts["pending"] == 0 and section_counts["external"] == 0:
            continue
        print(
            f"- {section}: "
            f"complete={section_counts['complete']} "
            f"pending={section_counts['pending']} "
            f"external={section_counts['external']}"
        )

    if show_pending:
        for task in tasks:
            if task.state in {"pending", "external"}:
                marker = "[ ]" if task.state == "pending" else "[!]"
                print(f"{marker} line {task.line}: {task.section} — {task.title}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "tracker",
        nargs="?",
        default="slybrowser-websites/docs/unimplemented-requirements.md",
        help="Path to the markdown task tracker.",
    )
    parser.add_argument(
        "--show-pending",
        action="store_true",
        help="Print every pending and external item with line numbers.",
    )
    args = parser.parse_args()

    tracker_path = Path(args.tracker)
    if not tracker_path.is_file():
        parser.error(f"tracker does not exist: {tracker_path}")

    print_summary(parse_tasks(tracker_path), args.show_pending)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
