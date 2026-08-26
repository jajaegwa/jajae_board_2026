# 자재과 작업판 Design System

## Metadata Block

```
version: 1.0
name: jajae-board-erp
description: An internal Korean manufacturing-ERP style dashboard for a materials department (자재과). Deliberately plain and utilitarian rather than "modern SaaS" — dense data-grid tables with visible cell borders, sharp corners (2px radius, near-flat), a system Korean UI font stack (no custom webfonts), and a light, low-contrast chrome (white/light-gray header and tab bar, not a dark hero bar). The one intentional exception is the 지게차(forklift driver) field screen, which keeps a dark high-contrast banner and larger touch targets for at-a-glance readability outdoors. Status is communicated with small outlined text chips rather than saturated pastel-filled badges, keeping the page visually quiet at high row density.
```

Reference point: this file follows the structure convention from [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) so future edits (by a human or an AI agent) can stay consistent with the existing look instead of drifting toward a generic "AI-generated app" aesthetic.

## Color Palette

All colors are CSS custom properties on `:root` in `index.html`, with light/dark variants (`prefers-color-scheme` + `[data-theme]` override). **Never rename these variables** — many are referenced directly via inline `style="color:var(--acc)"` etc. inside JS-generated HTML strings.

| Category | Token | Light | Dark | Purpose |
|---|---|---|---|---|
| **Surface** | `--bg` | `#eef0f2` | `#131a21` | Page background |
| | `--card` | `#ffffff` | `#1b242d` | Card/table/input surface |
| | `--head` | `#e9edef` | `#222d38` | Table header row, secondary surface (loc chip bg) |
| | `--row-hover` | `#f2f4f5` | `#212c37` | Table row hover |
| **Text** | `--ink` | `#20262b` | `#e6ebf0` | Default body text |
| | `--mut` | `#6b7480` | `#98a6b3` | Secondary/muted text, labels, hints |
| **Border** | `--line` | `#b9c0c6` | `#2e3a46` | Card border, table grid, input border |
| | `--line2` | `#d8dde1` | `#27323d` | Lighter cell divider, section rules |
| **Accent** | `--acc` | `#2f6f61` | `#7fb2e3` | Primary action, active tab, links, focus outline |
| | `--acc-soft` | `#e6efec` | `#20344a` | Subtle accent fill (dropzone hover) |
| **Warning** | `--amber` | `#a15a1c` | `#f0a64a` | Warn buttons, "임박"/지연 status |
| | `--amber-soft` | `#f2e6d8` | `#3b2c14` | (reserved, currently unused by chips — chips are outlined not filled) |
| **Danger** | `--red` | `#a83a2e` | `#f08c84` | Delete actions, 지연 status |
| | `--red-soft` | `#f4e0dd` | `#3f2220` | (reserved) |
| **Success** | `--green` | `#3a7d52` | `#7fcf97` | 완료 status |
| | `--green-soft` | `#e3ede6` | `#1d3a27` | (reserved) |
| **Dark chrome** | `--navy` | `#17222d` | `#0e141a` | Toast bg, 지게차 banner only — never the main header/nav |
| | `--navy-ink` | `#e9eef3` | `#e6ebf0` | Text on navy |
| **Department tags** | `--dept-gj` | `#245c8f` | `#7fb2e3` | 경질 (solid-fill white-text tag) |
| | `--dept-ch` | `#6c4bb3` | `#b49be8` | 창호 |
| | `--dept-tl` | `#b9640f` | `#f0a64a` | 타일 |
| | `--dept-dbp` | `#2a7a6b` | `#72c4b3` | DBP |

## Typography

No webfont is loaded. The stack relies on the OS's native Korean UI font so the app reads as ordinary business software, not a designed product:

```
font-family: 'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Dotum',sans-serif;
```

Numeric/code values (D-day, 창고 locator codes, mail preview, link fields) use a generic monospace stack for alignment, not a "designed" mono face:

```
font-family: Consolas,'Courier New',monospace;
```

| Token | Size | Weight | Where |
|---|---|---|---|
| body base | 13px | 500 | Page default (everything not listed below inherits this) |
| `h1` (header title) | 15px | 700 | App title |
| `h2` (card title) | 13.5px | 700 | Card/section headers |
| `td` | 12.5px | 500 (inherited) | Table cells |
| `td b` | 12.5px | 600 | Item/vendor/company names inside a cell — the one place bold is used for scannability |
| `th` | 11.5px | 700 | Table header row |
| `label` | 11px | 600 | Form field labels |
| `.btn` | 12.5px | 600 | Buttons |
| `.chip` | 11px | 700 | Status badges |
| `.stat .s .v` | 22px | 700, monospace | Big KPI numbers on 오늘 작업판 |
| 지게차 `.drv .item .name` | 19px | 700 | Driver-screen item name (large, for at-a-glance reading) |

Line-height 1.45. Numbers use `font-variant-numeric: tabular-nums` for column alignment even outside the monospace stack.

## Layout

- `main` max-width 1280px, centered, 14px vertical margin, 16px side padding.
- `.grid` = CSS grid, 12px gap. `.g2` = `repeat(auto-fit, minmax(340px, 1fr))` (auto-wraps to 2–3 columns depending on width). Single-column sections (e.g. `#boardCards`, `#stats`) pin `grid-template-columns` explicitly rather than fighting the auto-fit default.
- Card padding: 14px.
- No max-width constraint inside driver mode beyond 900px, to keep touch targets large on a phone.

## Elevation & Depth

Deliberately flat — this is the biggest lever against the "AI-generated" look. No card shadows.

| Element | Treatment |
|---|---|
| Card | 1px solid `--line` border only, no shadow |
| Dialog | 1px border + a modest `0 8px 24px rgba(0,0,0,.2)` shadow (the one place a shadow survives, since it needs to visually separate from the page) |
| Button / input / chip | flat, border only |

## Shapes

Radius scale is tiny and mostly uniform — square-ish, not the rounded-pill/rounded-card look of consumer SaaS:

| Radius | Used by |
|---|---|
| 2px | buttons, inputs, cards, chips, stat tiles, nav tabs, savebox, badges |
| 3px | dialog, phone-mode dept buttons |
| 4px | 지게차 screen item cards, banner (slightly softer — touch-screen context) |
| 50% | status dot in savebox only |

## Components

- **Buttons** (`.btn`): flat, 1px border, `--ink` text on `--card` background by default. `.pri` = solid `--acc` fill + white text (primary action, e.g. 조회/저장-equivalent). `.warn` = solid `--amber` fill + white text. `.ghost` = transparent. `.sm` = compact (used almost everywhere; the larger default size is rare).
- **Inputs/selects/textarea**: 1px `--line` border, `font: inherit` (so they pick up the page's font-weight/size rather than the browser's UI font), 1px `--acc` focus outline (not a glow/shadow).
- **Tables**: full grid — every `td`/`th` has its own border (not just row dividers), header row uses `--head` background. This is the single most "ERP-like" signal in the whole system; don't collapse it back to bottom-border-only rows.
- **Chips/status badges** (`.chip`, `.c-wait/.c-ord/.c-late/.c-done/.c-mut`): outlined, not filled — transparent background, 1px border + text in the semantic color. This keeps dense tables (many chips per row) visually quiet. Department tags (`.dept`) are the deliberate exception: solid color fill + white text, because they function as at-a-glance category labels, not status.
- **Nav tabs**: rendered like a folder-tab strip. Inactive tabs sit on `--head`/`--line2`, sharp top corners only (`border-radius: 2px 2px 0 0`). The active tab gets a solid `--acc` fill with white text — closer to a real ERP's selected-tab treatment than an underline-only SPA tab.
- **Header/nav chrome**: light (`--card`/`--head`), not a dark hero bar. The only dark-chrome components in the whole app are the toast and the 지게차 banner, both chosen deliberately for contrast/urgency, not as a leftover "SaaS dark header" habit.

## Do's and Don'ts

**Do**
- Keep every table cell bordered (grid look), header row shaded `--head`.
- Keep corners at 2px (or the documented exceptions above) — sharp, not rounded.
- Keep chips outlined/text-based; reserve solid color fills for department tags and primary buttons only.
- Right-align + tabular-nums for any quantity/currency/date-diff column.
- Reuse the existing CSS variables; add a new token only if none of the current ones fit semantically.

**Don't**
- Don't add a webfont or a "designed" typeface — system Korean UI font only.
- Don't add card drop-shadows, gradients, or rounded-pill buttons — that's the "AI-generated app" look this system was explicitly redesigned away from.
- Don't turn the main header/nav dark again — that reads as a generic modern-SaaS hero bar. Dark chrome is reserved for the toast and the 지게차 banner.
- Don't fill status chips with saturated pastel backgrounds — outline-only.
- Don't rename or remove CSS custom properties — several are referenced by exact name from inline `style="…var(--x)…"` strings generated in JS, not just from the `<style>` block.

## Responsive Behavior

- Tables scroll horizontally inside `.tbl{overflow-x:auto}` rather than reflowing — acceptable for an internal desktop-first tool.
- 지게차 (driver) screen is the one truly mobile-optimized surface: larger fonts/touch targets, `max-width:900px`, checkboxes sized to 22×22px.
- `@media (max-width:640px)`: dialog's 2-column grid collapses to 1 column; driver item rows stack instead of using the `1fr auto` grid.

## Iteration Guide

1. Token changes go in `:root` **and** both dark-mode blocks (`@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`) — they're kept in sync manually, not derived.
2. Before changing a component's visual style, grep `index.html` for the class name — most components are rendered as template-literal HTML from JS (`renderMoves`, `renderOrders`, `renderCs`, `renderDriver`, etc.), not static markup, so a style change usually only needs a CSS edit, but a *structural* change (e.g. adding a column) needs the matching JS render function updated too.
3. When adding a new status/semantic color, add it as a new `--x` / `--x-soft` pair following the existing naming pattern, define it in all three variable blocks (light, dark media query, dark data-theme), and prefer the outlined-chip treatment over a filled one for consistency.
4. Sanity-check any visual change in both the desktop admin view and the 지게차 driver view — they share the stylesheet but have different information density and viewing conditions (office monitor vs. phone in a truck).
