# Game Table UI/UX Design QA

## Comparison target

- **Source visual truth:** `C:\Users\Administrator\.codex\generated_images\01a05bce-6f18-74d3-949f-5fcf53bb1163\exec-31f1dd39-ba9f-476b-a904-6f365d33f922.png`
- **Rendered implementation:** `D:\project\river\design-demos\mobile\table-implementation-acceptance-normalized.png`
- **Side-by-side evidence:** `D:\project\river\design-demos\mobile\table-qa-comparison.png`
- **Local preview:** `http://localhost:5174/`

The reference is a 9-seat, post-flop visual mock; the rendered acceptance case is a 6-seat, pre-flop hand where the local player is prompted to act. The comparison therefore checks the confirmed layout and interaction treatment rather than matching transient cards, pot amount, or player count.

## Capture normalization

- Source: `852 × 1846` pixels, normalized to `390 × 844`.
- Browser viewport: `390 × 844` CSS pixels at device scale factor 1.
- Browser raw capture: `390 × 844` pixels. The in-app browser returned the CSS content at two-thirds scale in the upper-left portion of the raw capture, so the content region `260 × 563` was normalized back to `390 × 844` for the implementation comparison. The unmodified browser capture is retained at `design-demos/mobile/table-implementation-acceptance.png`.
- State: local player’s pre-flop turn; two private-room players seated; action dock visible; no community cards dealt.

## Full-view and focused comparison

The combined image above was reviewed full-frame, then in these focused regions:

1. Local-player lower region: stack, hole cards, history shortcut, quick-chat shortcut, and the temporary action dock.
2. Opponent and upper-seat region: status label, circular player surface, state ring, name/stack, and per-street bet position.

## Findings

No actionable P0, P1, or P2 findings remain.

- [P3] Illustrative avatar photography is not present in the product data model.
  Location: player circles in `apps/web/src/App.tsx`.
  Evidence: the visual reference uses profile photography; the implementation renders the player’s existing initial because the current API exposes `nickname` only and has no avatar URL or asset source.
  Impact: the seat state, status, stack, betting position, and current-turn highlight remain legible, but the image treatment is less expressive.
  Follow-up: add an optional profile-avatar field and served image asset when profile media is in scope; do not substitute generated identities for real player profiles.

- [P3] The reference depicts a 9-seat post-flop table while the acceptance scenario is a live 6-seat pre-flop hand.
  Location: table perimeter and board.
  Evidence: this is intentional runtime content variation, not a component mismatch. The 6/9-seat layout test passes at both mobile and desktop breakpoints.
  Impact: none for the requested placement and interaction rules.

## Required fidelity surfaces

- **Fonts and typography:** compact numeric labels use tabular figures; player names truncate instead of colliding; current-turn, status, stack, and action labels maintain distinct hierarchy.
- **Spacing and layout rhythm:** hero seat is lower, personal cards are below it, history and quick chat sit at lower-left/lower-right, and the enlarged felt keeps the action area clear.
- **Colors and visual tokens:** the felt was adjusted to a dark blue-green field closer to the confirmed direction; active state uses gold, fold uses muted gray, and the portrait action popup stays translucent without covering the cards.
- **Image quality and asset fidelity:** no source product avatar asset was supplied. Existing live player initials are retained rather than inventing profile imagery; see P3 follow-up.
- **Copy and content:** `FOLD`, `ALL IN`, turn state, per-round wager, `手牌记录`, `常用语`, and action labels are readable and reflect live game state.

## Interaction, responsiveness, and accessibility checks

- Only the local player whose turn it is receives `.actionDock`; the opposing client has no action dock in the DOM.
- Fold, call/check, and raise appear in an absolute-positioned, semi-transparent portrait popup. It does not consume table height and remains above the personal cards.
- 44px-or-larger history, quick-chat, and action targets are retained on mobile.
- `aria-label` values cover hand history, quick chat, player betting amounts, and invitation copy actions.
- Browser console: 0 error entries during the final preview.
- Automated verification: web production build, 19 web unit tests, the full mobile private-table suite (8 tests), and the focused two-client turn-state test all pass.

## Implementation checklist

- [x] Move the local-player group and hole cards to the lower table area.
- [x] Place hand history lower-left and quick chat lower-right.
- [x] Show player state above circular seat content and stack below it.
- [x] Position local wager above the local player and opponent wagers toward the table center.
- [x] Render action controls only on the acting client as a translucent portrait popup without changing table dimensions.
- [x] Validate mobile table interaction and 6/9-seat stability.

## Follow-up polish

- Add real optional player avatar media once the account/profile model provides it.

final result: passed
