# River Table 9-seat layout design QA

- Source visual truth: `D:/project/river/doc/river-table-mobile-poker-ui.png`
- Implementation screenshot: `C:/Users/Rhea/.codex/visualizations/2026/08/28/01a048b5-84c9-7740-acc1-ca1011ddd10c/river-nine-seat-table-after.png`
- Side-by-side comparison: `C:/Users/Rhea/.codex/visualizations/2026/08/28/01a048b5-84c9-7740-acc1-ca1011ddd10c/river-nine-seat-comparison.png`
- Viewport: 375 × 812 CSS px, portrait mobile
- Source pixels: 853 × 1854; normalized with aspect-fill to 375 × 812 for comparison
- Implementation pixels: 375 × 812 at device scale factor 1
- State: active 9-seat table, two occupied seats, seven empty relative seats, local player fixed at bottom

## Full-view comparison evidence

The implementation matches the requested spatial features from the reference: a tall narrow oval felt, an opposite seat at the top, four relative seat bands around the left/right rail, the local player anchored at the bottom, and pot/community cards centered on the vertical axis. The rendered felt measured 285 × 533 px at x=45/y=87, with no document overflow at 375 × 812.

The source image is a layout reference rather than a request for a full visual clone. The implementation intentionally preserves River Table's existing navigation, action controls, typography, initials-based avatars, colors, and gameplay state. Reference-only chat, microphone, portrait artwork, and balance toolbar were not added.

## Focused region comparison

A separate focused crop was not needed because the requested change concerns macro table geometry and seat distribution, which are legible in the normalized full-view side-by-side comparison. The administrator credit controls were verified independently in `river-admin-credit-after.png`.

## Required fidelity surfaces

- Fonts and typography: existing River Table font stack and numeric hierarchy remain consistent; no clipping or unintended wrapping was observed.
- Spacing and layout rhythm: the 9-seat felt is now 76% wide and 91% high; seats form a balanced top/side/bottom ring and the action dock remains unobstructed.
- Colors and tokens: existing navy, felt green, gold rail, and semantic action colors remain unchanged and readable.
- Image quality and asset fidelity: no new image asset was required because the request scoped the reference to table background layout. The supplied source was not stretched or embedded into the product UI.
- Copy and content: gameplay and administrator copy remain product-specific; ledger entries now identify the target player.
- Accessibility and interaction: controls retain semantic buttons/inputs, labels, disabled states, keyboard operation, and reduced-motion support.

## Findings

No actionable P0, P1, or P2 differences remain within the requested scope.

P3 intentional deviations: River Table retains initials avatars and a cleaner code-native rail rather than copying the reference portraits and leather texture. These do not affect the requested 9-seat background layout.

## Comparison history

- Baseline: the previous 9-seat rules used the same broad 104% × 68% felt geometry as the 6-seat table, creating a wide landscape ellipse.
- Fix: introduced 9-seat-specific 76% × 91% portrait felt geometry and redistributed visual offsets 1–8 around the rail.
- Post-fix evidence: `river-nine-seat-table-after.png` and `river-nine-seat-comparison.png`; no P0/P1/P2 follow-up iteration was required after the first rendered comparison.

## Browser verification

- URL: `http://localhost:5173/?qa=rules-v2`
- Page title: `River Table`
- Primary interactions: administrator self-credit field clear/restore; disabled submit on empty value; enter 9-seat table.
- Console errors/warnings: none.
- Framework error overlay: absent.
- Horizontal overflow: absent (`scrollWidth = clientWidth = 375`).

final result: passed
