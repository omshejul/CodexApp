# Plan UI Change Spec

## Summary

Make plan output a first-class thread artifact in the Expo app instead of rendering it as generic activity text.

This change covers:

- markdown rendering for plan content
- explicit follow-up actions on plan cards
- parity between live plan cards and finalized historical plan cards

This change does not cover:

- server protocol changes
- plan approval state persisted to the backend
- automatic execution when a plan action is tapped

## Current Problem

- `Plan` is currently rendered through the same generic activity card path as `Reasoning` and `Tool progress`
- markdown headings, lists, and code blocks render as raw text
- users are dropped back into a generic `Continue this thread...` composer with no clear next action

## Target UX

### Historical plan card

- render the plan body as markdown
- show a visible `Plan` label
- show two actions under the plan:
  - `Implement`
  - `Revise`

### Live plan card

- use the same visual treatment and action row as historical plan cards
- update live as plan content streams
- preserve the final rendered markdown after completion

### Plan actions

- `Implement` should prepare a concrete follow-up prompt in the composer:
  - `Implement the latest approved plan.`
- `Revise` should prepare a concrete follow-up prompt in the composer:
  - `Revise the latest plan. Changes I want:`
- tapping either action should focus the composer
- actions should not auto-send in this version

## Implementation Notes

- Keep plan rendering local to the app UI
- Reuse the existing markdown renderer and rules already used for assistant content
- Introduce a dedicated `PlanActivityCard` component in the thread render path
- Use the same component from both:
  - historical thread row rendering
  - live footer rendering

## Acceptance Criteria

- plan cards render markdown instead of raw markdown text
- live and historical plan cards share the same layout
- plan cards expose explicit `Implement` and `Revise` actions
- tapping a plan action inserts the expected follow-up text into the composer and focuses the input
- no regression to reasoning, terminal output, file changes, or tool progress rendering
