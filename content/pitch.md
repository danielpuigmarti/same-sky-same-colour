# Pitch

Three minutes, spoken. The words between square brackets are for the speaker and are not counted. The recorded clip of the video takes over if the photos of a typed position have not arrived within eight seconds.

## Script

[Open the home page.]

NASA's SPHEREx telescope photographs the whole sky every six months, in {{spherex.colours}} infrared colours. The challenge asks for a tool that shows what changes between photos, like a little video.

Here is the trap. Every point of a SPHEREx photo has its own colour, and the colour changes steadily across the camera. So two photos of the same star are usually at two different colours. Blink them and the star seems to change. [Choose "All photos of one visit".] These are steady stars. Across all {{lie.photos.all}} photos of one visit, a star's brightest reading is {{lie.swing.all}} times its faintest, a median over {{lie.stars.all}} stars. [Choose "Same colour".] Match the colour, in photos months apart, and two readings of a steady star agree to {{lie.swing.matched}}, a median over {{lie.stars.matched}} stars. That is the idea of {{site.name}}: find the photos of your position that share a colour, and blink only those. Whatever still changes is worth a closer look.

[Point at the comet: the August photo, then the four photos of {{e1.lemmon.date.feb}}.]

Comet Lemmon. On the left, {{e1.lemmon.date.aug}}, at the colour of carbon dioxide: nothing there. In the middle, {{e1.lemmon.date.feb}}, at a colour just beside it: a small smudge. On the right, {{lemmon.hero.minutes}} minutes later, at the colour of carbon dioxide: a wide glow. Same sky, and the colour is the main thing that changed. At that colour the comet is {{lemmon.contrast.feb26}} brighter than at the colours beside it. The ratio moves with how we measure, from {{lemmon.contrast.feb26.nopeak}} to {{lemmon.contrast.feb26.moved.high}} on this night, and the brightness is a lower limit. We do not say how much gas there is. Our air blocks this colour, so it takes a telescope in space.

[Type Epsilon Indi B into the box.]

Now a star. I type Epsilon Indi B. The page asks NASA's public archive directly from your browser. There is no server and no account. It pairs the photos by colour and blinks them. This pair of brown dwarfs has moved {{targets.eps-indi-b.shift.measured}} arcseconds since WISE photographed it from {{targets.eps-indi-b.wise.first}}, and it lands where ESA's Gaia says it should.

[Open the Checks page.]

Every claim has a card: a number, the rule written before the test, and whether a person has reviewed it: so far {{v4.checks.reviewed}} of {{v4.checks.total}}. Some cards say what failed. A number nobody has checked says so.

What could it become? A place where anyone types a position, sees what has changed, and knows how far to trust it.

## Questions

### What is new here?

The colour match: the page picks only photos taken at the same colour, by one written rule, so a change of colour cannot pass for a change in the sky.

### What about absolute flux?

We make no claim: the comet's fluxes are lower limits, taken in a small circle, and they are not tied to other telescopes.

### How is it different from IRSA's own tools?

IRSA gives the data and the ways to fetch it, and we use them to check our work; what we add is the choice of photos by colour, with the checks shown.

### What does it cost to run?

Nothing per visit: it is static files on GitHub Pages, the browser reads NASA's public bucket itself, and there is no server, account or tracking.

### What failed?

{{v4.checks.fail}} checks failed: the difference at a typed position, which is switched off there, and the Pluto and gallery ideas. Without its brightest photo, the comet's contrast on the night before falls to {{lemmon.contrast.feb25.nopeak}}.
