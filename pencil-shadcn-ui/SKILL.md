---
name: pencil-shadcn-ui
description: Designs web and SaaS UIs in Pencil (.pen) using shadcn/ui-style components from an embedded design system. Uses Pencil MCP only for .pen I/O. Use when the user asks for shadcn-based UI in Pencil, .pen designs aligned with shadcn/ui, or combining Pencil MCP with Tailwind/shadcn patterns.
---

# Pencil MCP + shadcn/ui design

## Hard rules

- **`.pen` files are encrypted.** Read, search, and edit **only via Pencil MCP tools**. Do **not** use workspace `Read` / `Grep` on `.pen` files.
- **Component `ref` IDs are file-specific.** Never invent IDs. Always discover them inside the target `.pen` with `batch_get`.

## Startup workflow

1. **`get_editor_state(include_schema: true)`** — active `.pen`, selection, schema.
2. **`open_document`** if nothing is open or the user names a path.
3. **`get_guidelines`** (call multiple topics as needed):
   - `web-app` — web app screens from scratch
   - `design-system` — compose screens from reusable components (SaaS, dashboards)
   - `tailwind` — align with Tailwind v4 when implementation matters
4. **Discover shadcn-aligned components in one `batch_get`** (avoid one-by-one reads):
   - e.g. `patterns: [{ "reusable": true }]`, keep `readDepth` / `searchDepth` modest to avoid huge payloads
   - narrow by `name` (regex) when the file is large

## Mapping shadcn/ui to the canvas

- **Match by semantics**: pick reusable frames that correspond to **Button, Card, Input, Label, Badge, Tabs, Dialog shell, Sheet, Table, Alert**, etc., and place them as **instances** (`type: "ref", ref: "<id>"`).
- **Visual conventions** (keeps handoff to code simple):
  - Radius: **medium** feel (`rounded-md`-like), unless the kit specifies otherwise
  - Spacing: **multiples of 4** (8, 12, 16, 24…)
  - Hierarchy: **background → card → border**; limit one primary CTA per view when possible
- Prefer **theme variables** for color and type: `get_variables` / `set_variables` for light/dark consistency.

## Build and verify

- **`batch_design`**: **max 25 operations** per call; split large screens by section.
- For instances: update nested nodes with **`U("instanceId/descendantId", { ... })`** or **`R(...)`**. After **`C()`**, do not **`U`** old descendant IDs (they change).
- Layout: **`snapshot_layout`**. Visual check: **`get_screenshot`**.
- If the user wants **implementation**: read **`get_guidelines(topic: "code")`**, then output shadcn + Tailwind structure that matches the canvas.

## More detail

- For a shadcn ↔ component naming cheat sheet, read [reference.md](reference.md).
