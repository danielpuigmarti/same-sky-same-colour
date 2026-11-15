# Project page

## Project name

{{site.name}}

## High-level summary

Type any sky position and blink NASA SPHEREx images taken months apart at the same infrared colour, so a change of colour cannot pass for a change in the sky, such as comet Lemmon's carbon-dioxide glow.

SPHEREx is a NASA space telescope that photographs the whole sky every six months in {{spherex.colours}} infrared colours. Every pixel of a photo has its own colour, and the colour changes steadily across the camera, so two photos of the same star usually catch it at two different colours. Across all {{lie.photos.all}} photos of one visit, a steady star's brightest reading is {{lie.swing.all}} times its faintest (median of {{lie.stars.all}} stars beside RW Aurigae). The stars have not changed, but anyone comparing photos the obvious way will find changes that are not real. We built a web page that finds the photos of one position that share a colour and blinks only those; two photos matched in colour, months apart, agree to a factor of {{lie.swing.matched}} (median of {{lie.stars.matched}} stars). It reads NASA's archive from the browser, with no server.

Because the colour is matched, what still changes is worth a closer look: a star that moves, or a comet that glows at a colour of its own. At the colour of carbon dioxide, comet Lemmon is {{lemmon.contrast.feb26}} brighter than at the colours beside it, and the same patch of sky at that colour in August is empty. It is tested on the five targets the challenge names, and every claim opens the check behind it, failures included.

## Detailed description

Try it

Open https://danielpuigmarti.github.io/same-sky-same-colour/. "The comet" shows comet Lemmon's glow at one infrared colour. "Blink a place" takes a star's name or a sky position and blinks the photos that share a colour.

What it does

You type a star's name or a sky position covered by SPHEREx Data Release 1. The page finds the photos that cover it, groups them into visits (one pass of the telescope over that patch of sky), and pairs photos from two visits that share a colour. It blinks each pair, wipes a curtain across them, or shows them side by side. The five targets of the challenge are ready.

How it works

There is no server. A list of every photo of the data release ships as small files. For a position, the browser reads the one small file that covers it, asks NASA's public bucket for the header of each candidate photo, works out where the position falls on the camera and at which colour, pairs the photos by colour, and reads only the few rows of pixels it needs. The colour of every pixel comes from the wavelength tables in the photo headers; our copy of them is {{wave.tables.bytes}} bytes for all six detectors.

How it answers the challenge

{{@challenge}}

How we checked

- Colour axis: our tables reproduce those in the photo headers to {{wave.tables.error_maps}} micrometres. Against IRSA's own wavelength maps they differ by {{wave.cwave.d1.rms_nm}} to {{wave.cwave.d4.rms_nm}} nm rms, and by up to {{wave.cwave.d2.max_nm}} nm at some pixels of the second detector. On two hydrogen lines of a planetary nebula, Paschen-beta fitted at {{lines.pab.fit}} micrometres against {{lines.pab.expected}} expected, and Brackett-alpha at {{lines.bra.fit}} against {{lines.bra.expected}}.
- Comet: on the two nights it sat within {{lemmon.track.offset.feb25}} pixel of where JPL Horizons puts it.
- Speed: the opening pair of pictures came in a median of {{live.first_pair.median_s}} seconds over {{live.positions}} tested places, worst {{live.first_pair.worst_s}}.

Comet Lemmon

On {{e1.lemmon.date.feb}} SPHEREx took four photos of the comet within a few minutes, each at a different colour. At the colour of carbon dioxide the comet is {{lemmon.contrast.feb26}} brighter than at the colours beside it, and on the night before {{lemmon.contrast.feb25}}. The same sky at the same colour on {{e1.lemmon.date.aug}} is empty. These figures move with how we measure: on the later night from {{lemmon.contrast.feb26.nopeak}} to {{lemmon.contrast.feb26.moved.high}} (a wider circle gives {{lemmon.contrast.feb26.wide}}), and on the night before {{lemmon.contrast.feb25.nopeak}} without its brightest photo. The brightness is a lower limit: we measure inside a circle {{lemmon.aperture.arcsec}} arcseconds in radius and the glow is wider. We do not claim how much gas there is. Whether anyone has measured this gas before is on the Checks page.

Benefits

The page is for people who watch variable stars and comets, volunteers who search for moving objects, teachers, and the curious. It says what it cannot do. Very bright stars saturate and get no brightness; of the {{e1.rwaur.bands.total}} colour bands of RW Aurigae, {{e1.rwaur.bands.hidden}} are marked too bright to measure reliably. Asteroids are not checked. The Checks page lists every check, failures and limits included; a person has reviewed {{v4.checks.reviewed}} of {{v4.checks.total}} so far.

What we hope to achieve

We hope anyone can look at a patch of sky, see whether something has changed and how far to trust it, and that a new release can be added by listing its photos again.

Tools and languages

JavaScript (no framework, no build step), HTML and CSS for the site; Python with Astropy, NumPy, SciPy, Matplotlib and Requests for the offline preparation and the reference values; Node.js, TypeScript's type check and Playwright for the tests; GitHub Pages for hosting. The code is Apache-2.0.

## NASA data

SPHEREx Data Release 1, Level 2 spectral images, from the nasa-irsa-spherex bucket at NASA/IPAC Infrared Science Archive (IRSA). The page reads them live, a few rows at a time.

The WCS-WAVE wavelength tables in the headers of those images, and IRSA's own spectral WCS product, which our tables are compared with.

IRSA's Simple Image Access (SIA) service, collection spherex_dr1, used offline to build the list of photos and to cross-check it.

NASA JPL Horizons, for the positions of the comet as seen from SPHEREx.

AllWISE Atlas images (WISE, NASA/IPAC IRSA), for the pictures of the moving targets taken by WISE long before SPHEREx.

## Space agency partner data and other references

ESA (European Space Agency), Gaia Data Release 3: positions, proper motions and parallaxes of stars, the reference for the motion of Barnard's Star and Epsilon Indi B and for the place of every photo on the sky.

The full list, with the address and the licence of each item:

{{@references}}
