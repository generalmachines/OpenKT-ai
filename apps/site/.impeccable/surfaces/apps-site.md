# apps/site

Scope: the OpenKT marketing landing page. Static HTML and CSS, no build step, no JavaScript.
Visitor mode: Persuade. Audience: knowledge workers on a small team, each of whom already
works with their own AI assistant. Action: install the Mac app; a secondary path self-hosts.

## Positioning

The product removes two handoffs nobody should have to do:

1. Pasting what a meeting decided into your own assistant.
2. Relaying what your assistant worked out to everybody else.

Everything on the page serves those two sentences. It is not a meeting recorder and it is
not a wiki, and no section may be written as if it were.

## Binding constraints, all user-pinned

- heyaside.com is the register and the composition reference. Consumer, never developer.
- No em dashes anywhere, including inside rendered screenshots.
- No status, roadmap or pre-release language. Write from the end-state product.
- Light mode throughout.
- One story, few sections. Repetition of a section shape is a defect.
- Authored UI components in code, not a row of product screenshots.
- Scroll animation expected.

## Direction contract

THESIS: The engraving is the surface the product is printed on. The page opens on a faux
macOS desktop whose wallpaper is Gutenberg taking the first proof, and the middle of the page
is a single scroll reel in which three sheets of a printing-house engraving are laid down one
over another, the frame fixed and only the product surface on it changing. It refuses the
developer-tool page of bold left-aligned headings over hairline lists, and it refuses the
three-sections-in-a-row shape of title, subtitle, screenshot.

OWN-WORLD: Warm paper #fdfcfa, #f6f3ec, #efeae0 under a fixed fractal-noise grain at 5%.
Ink #211f1c, #5f5950, #6a6458, #757063. Hairlines #e7e2d8. One terracotta accent #b4532a,
which the sepia grade of every engraving was tuned to sit beside. Kind dots in terracotta,
moss, slate, ochre, plum. Geist at weight 400 for section headings, centred; 500 is permitted
for small in-card titles, FAQ questions and the three-up labels, where 400 loses hierarchy.
Geist Mono for everything the machine wrote. Product surfaces are white cards with a y-offset
soft shadow, floating on sepia engraving plates.

STORY: A familiar Mac desktop, and a product that belongs on it. Three statements of what it
does for you: meetings reach your agent, your work reaches your team, you do neither by hand.
Then the reel proves it in three states. Then syncing is shown to be automatic while sharing
is not. Then the tools it lives inside, the two ways to run it, and the objections.

FIRST VIEWPORT: Full-bleed sepia engraving as wallpaper. A translucent macOS menu bar carrying
the wordmark and the nav. A MacBook, 660px wide, centred above the midline with a drop shadow
and no notch, because the screenshot inside it has no menu bar of its own. Below it, centred
white type: the headline at up to 58px weight 400, a three-line sub, one white pill, a note.
Everything inside one viewport.

FORM: Desktop-as-page with a stacking-sheet reel. Pinned by the user's brief across many
rounds, so no concept-seed roll was run; a brief-pinned direction beats the roll.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the
verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Known, accepted detector findings

Soft wide shadows on the floating windows, the diagonal hatch on withheld search rows, and
Geist as the only face are all the committed world, not defaults reached for by accident.
The cramped-padding findings come from absolutely positioned children and nested wraps.

## Capture note

Full-page screenshots of this page render the footer blank. That is a Chromium full-page
capture artifact caused by the fixed grain overlay on a very tall document, not a layout bug;
the footer paints correctly in a real scrolled viewport. Capture the footer by scrolling to it
with `scroll-behavior: auto` forced, never from a full-page shot.
