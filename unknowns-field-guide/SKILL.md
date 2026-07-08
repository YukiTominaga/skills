---
name: unknowns-field-guide
description: Use before writing code for ambiguous, unfamiliar, multi-step, or reviewer-sensitive implementation work. Runs a blindspot pass for unknown unknowns, explores prototypes and references, plans likely-to-change decisions first, logs deviations, explains the result, and quizzes understanding.
---

# Unknowns Field Guide

## Purpose

Use this skill to make hidden assumptions visible before they become expensive. The core model is simple: the prompt, plan, and artifacts are the map; the real codebase, users, constraints, and reviewers are the territory; unknowns are the gaps between them.

Use it before implementation, not only after things go wrong. If the work is small and clear, run a light pass. If it is ambiguous, unfamiliar, visible to users, or likely to involve review, run the full pass.

## Unknowns

Classify uncertainty into four groups:

- Known Knowns: what the prompt, issue, spec, or provided artifact already says.
- Known Unknowns: questions the user or agent can already name.
- Unknown Knowns: preferences or quality bars the user can recognize only after seeing concrete options.
- Unknown Unknowns: constraints, prior art, failure modes, or standards the user has not considered.

Use the literal phrases "blindspot pass" and "unknown unknowns" when the goal is to find hidden constraints.

Calibrate instruction detail. Overly specific instructions can prevent a needed pivot; vague instructions can lead to generic choices that do not fit the actual system.

## Before Implementation

1. Start with a blindspot pass. Search the relevant code, docs, tests, issues, logs, examples, and public sources. List Unknown Unknown candidates and the evidence needed to resolve them.
2. Brainstorm or prototype when the user will know the target only after seeing options. Prefer cheap artifacts: HTML mockups, screenshots, fake-data prototypes, diagrams, or sample payloads.
3. Interview when Known Unknowns remain. Ask one question at a time, prioritizing answers that would change architecture, data shape, security, UX, scope, cost, or review strategy.
4. Use references when the user cannot describe the target precisely. Source code is the strongest reference; read it directly and reuse the semantics even if it is written in another language.
5. Write an implementation plan. Lead with decisions likely to change: data models, interfaces, UX, permissions, security, rollout, cost, migration, and validation. Put mechanical edits later.

## During Implementation

Keep temporary implementation notes for substantial work. Include:

- Decisions made.
- Deviations from the plan.
- Edge cases found.
- Evidence collected.
- Validation performed.
- Open questions.

If an edge case forces a deviation from the plan, choose the conservative option, log it under "Deviations", and keep going within normal tool, permission, security, and destructive-action rules.

## After Implementation

Create a review-ready explainer or pitch:

- What changed and why.
- What unknowns were resolved, with evidence.
- What risks remain.
- How validation was performed.
- What reviewers should inspect first.

For substantial changes, create a quiz covering behavior, existing code paths, failure modes, validation, and reviewer concerns. Treat perfect answers as the merge or presentation readiness gate.

## Minimum Output

For short tasks, output only: blindspots checked, plan, implementation notes if any, validation, and remaining risks.

For larger tasks, include: unknowns brief, plan, implementation notes, review explainer, and quiz.
