# Project page

## Project name

Length: 21 characters (1 to 80)

Same Sky, Same Colour

## High-level summary

Length: 1,396 characters (600 to 1,400)

Type any sky position and blink NASA SPHEREx images taken months apart at the same infrared colour, so a change of colour cannot pass for a change in the sky, such as comet Lemmon's carbon-dioxide glow.

SPHEREx is a NASA space telescope that photographs the whole sky every six months in 102 infrared colours. Every pixel of a photo has its own colour, and the colour changes steadily across the camera, so two photos of the same star usually catch it at two different colours. Across all 112 photos of one visit, a steady star's brightest reading is 11.8 times its faintest (median of 20 stars beside RW Aurigae). The stars have not changed, but anyone comparing photos the obvious way will find changes that are not real. We built a web page that finds the photos of one position that share a colour and blinks only those; two photos matched in colour, months apart, agree to a factor of 1.02 (median of 14 stars). It reads NASA's archive from the browser, with no server.

Because the colour is matched, what still changes is worth a closer look: a star that moves, or a comet that glows at a colour of its own. At the colour of carbon dioxide, comet Lemmon is about 16 times brighter than at the colours beside it, and the same patch of sky at that colour in August is empty. It is tested on the five targets the challenge names, and every claim opens the check behind it, failures included.

## Detailed description

Length: 3,990 characters (2,400 to 4,000)

Try it

Open https://danielpuigmarti.github.io/same-sky-same-colour/. "The comet" shows comet Lemmon's glow at one infrared colour. "Blink a place" takes a star's name or a sky position and blinks the photos that share a colour.

What it does

You type a star's name or a sky position covered by SPHEREx Data Release 1. The page finds the photos that cover it, groups them into visits (one pass of the telescope over that patch of sky), and pairs photos from two visits that share a colour. It blinks each pair, wipes a curtain across them, or shows them side by side. The five targets of the challenge are ready.

How it works

There is no server. A list of every photo of the data release ships as small files. For a position, the browser reads the one small file that covers it, asks NASA's public bucket for the header of each candidate photo, works out where the position falls on the camera and at which colour, pairs the photos by colour, and reads only the few rows of pixels it needs. The colour of every pixel comes from the wavelength tables in the photo headers; our copy of them is 32,240 bytes for all six detectors.

How it answers the challenge

- Public web tool for SPHEREx images: built.
- Enter coordinates: built.
- Images like a little video: partly built.
- The five named targets: built.
- Easy to update: partly built.
- Infrared colours: built.
- Six detectors added together: partly built.
- Spectra on the fly: built.
- Add or subtract images: partly built.
- Choose the field of view: not built.
- Gaia and WISE overlays: partly built.
- Coordinates in the address: built.
- Contamination flags: built.
- Astropy and Aladin: built.
- Easy for anyone: partly built.
- The challenge's resources: partly built.
- Help volunteers: partly built.

How we checked

- Colour axis: our tables reproduce those in the photo headers to 2.4e-07 micrometres. Against IRSA's own wavelength maps they differ by 0.37 to 0.91 nm rms, and by up to 26.0 nm at some pixels of the second detector. On two hydrogen lines of a planetary nebula, Paschen-beta fitted at 1.28184 micrometres against 1.28188 expected, and Brackett-alpha at 4.04989 against 4.05137.
- Comet: on the two nights it sat within 0.4 pixel of where JPL Horizons puts it.
- Speed: the opening pair of pictures came in a median of 3.3 seconds over 27 tested places, worst 4.6.

Comet Lemmon

On 26 February 2026 SPHEREx took four photos of the comet within a few minutes, each at a different colour. At the colour of carbon dioxide the comet is about 16 times brighter than at the colours beside it, and on the night before about 10 times. The same sky at the same colour on 10 August 2025 is empty. These figures move with how we measure: on the later night from 8.1 to 17.3 (a wider circle gives 10.9), and on the night before 3.1 without its brightest photo. The brightness is a lower limit: we measure inside a circle 12.3 arcseconds in radius and the glow is wider. We do not claim how much gas there is. Whether anyone has measured this gas before is on the Checks page.

Benefits

The page is for people who watch variable stars and comets, volunteers who search for moving objects, teachers, and the curious. It says what it cannot do. Very bright stars saturate and get no brightness; of the 6 colour bands of RW Aurigae, 4 are marked too bright to measure reliably. Asteroids are not checked. The Checks page lists every check, failures and limits included; a person has reviewed 0 of 26 so far.

What we hope to achieve

We hope anyone can look at a patch of sky, see whether something has changed and how far to trust it, and that a new release can be added by listing its photos again.

Tools and languages

JavaScript (no framework, no build step), HTML and CSS for the site; Python with Astropy, NumPy, SciPy, Matplotlib and Requests for the offline preparation and the reference values; Node.js, TypeScript's type check and Playwright for the tests; GitHub Pages for hosting. The code is Apache-2.0.

## NASA data

Length: 637 characters (at least 200)

SPHEREx Data Release 1, Level 2 spectral images, from the nasa-irsa-spherex bucket at NASA/IPAC Infrared Science Archive (IRSA). The page reads them live, a few rows at a time.

The WCS-WAVE wavelength tables in the headers of those images, and IRSA's own spectral WCS product, which our tables are compared with.

IRSA's Simple Image Access (SIA) service, collection spherex_dr1, used offline to build the list of photos and to cross-check it.

NASA JPL Horizons, for the positions of the comet as seen from SPHEREx.

AllWISE Atlas images (WISE, NASA/IPAC IRSA), for the pictures of the moving targets taken by WISE long before SPHEREx.

## Space agency partner data and other references

Length: 15,126 characters (at least 200)

ESA (European Space Agency), Gaia Data Release 3: positions, proper motions and parallaxes of stars, the reference for the motion of Barnard's Star and Epsilon Indi B and for the place of every photo on the sky.

The full list, with the address and the licence of each item:

- 2MASS Point Source Catalog, J, H and Ks magnitudes, as served by the Gaia archive (gaiadr1.tmass_original_valid) (Public (2MASS data are free to use; acknowledgement asked for)): https://irsa.ipac.caltech.edu/Missions/2mass.html
- AllWISE Atlas (L3a) Coadd Images, band W2 (Public, no usage restrictions (IRSA terms of use, https://irsa.ipac.caltech.edu/data_use_terms.html); acknowledgement asked for): https://doi.org/10.26131/IRSA153
- AllWISE Atlas images, band W2 (4.6 µm), taken in 2010 (Public, no usage restrictions (IRSA terms of use); doi:10.26131/IRSA153): https://irsa.ipac.caltech.edu/ibe/docs/wise/allwise/p3am_cdd/
- Gaia Data Release 3 (CC BY-SA 3.0 IGO (ESA/Gaia/DPAC); the 73 stars of pipeline/tests/p1_data/gaia_barnard_d2.json are an excerpt, kept under the same licence): https://www.cosmos.esa.int/web/gaia/dr3
- Gaia Data Release 3, gaia_source (astrometry of Barnard's Star, Epsilon Indi B, RW Aurigae, R Draconis and seven other fast stars) (CC BY-SA 3.0 IGO (ESA Gaia data licence; acknowledgement asked for)): https://gea.esac.esa.int/archive/
- Gaia Data Release 3, table gaia_source (CC BY-SA 3.0 IGO (ESA/Gaia/DPAC); site/data/gaia/fast.json and pipeline/jobs/_rwaur_stars.py are excerpts, kept under the same licence): https://doi.org/10.5270/esa-qa4lep3
- IRSA table of the SPHEREx observations of comet 3I/ATLAS (obscore_3I_Atlas.vot) (Public, no usage restrictions (IRSA terms of use)): https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/obscore_3I_Atlas.vot
- JPL Horizons ephemeris service (positions of comet C/2025 A6 (Lemmon) and Pluto) (Public, NASA/JPL data, no restriction): https://ssd.jpl.nasa.gov/horizons/
- NASA/IPAC Extragalactic Database (NED), as answered by the Sesame name resolver (Public, funded by NASA and operated by Caltech; no formal terms of use, acknowledgement asked for): https://ned.ipac.caltech.edu/
- NIST Atomic Spectra Database, hydrogen I, vacuum wavelengths (Public (NIST Standard Reference Data, free to use with citation)): https://physics.nist.gov/PhysRefData/ASD/lines_form.html
- SIMBAD astronomical database, as answered by the Sesame name resolver (position, proper motion, parallax and radial velocity of a named object) (Free without registration under the ODbL licence; citing Wenger et al. 2000, A&AS 143, 9 is asked for): https://simbad.cfa.harvard.edu/simbad/
- SIMBAD astronomical database, entry WISEA J085510.74-071442.5 (astrometry of WISE 0855-0714 from Kirkpatrick et al. 2021, ApJS 253, 7; the paper was not opened) (Free for research use, with acknowledgement): https://simbad.cds.unistra.fr/
- SIMBAD astronomical database, tables basic, ident and flux (names, kinds, positions, proper motions, parallaxes, radial velocities and V-band magnitudes of about 1400 well-known places of the sky; Wenger et al. 2000, A&AS 143, 9) (Open Database License (ODbL); the acknowledgement "This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France" is carried in the file): https://simbad.cds.unistra.fr/simbad/
- SPHEREx Data Release 1, Level 2 spectral images (Public, no usage restrictions (IRSA terms of use, https://irsa.ipac.caltech.edu/data_use_terms.html); acknowledgement asked for): https://irsa.ipac.caltech.edu/Missions/spherex.html
- SPHEREx Data Release 1, list of frames from the IRSA image search (collection spherex_dr1) (Public, no usage restrictions (IRSA terms of use)): https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1
- SPHEREx Data Release 1, Spectral WCS product cal-swcs-v5-2026-191 (CWAVE layer) (Public, no usage restrictions (IRSA terms of use)): https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/spectral_wcs/cal-swcs-v5-2026-191/
- Astropy (BSD-3-Clause): https://www.astropy.org/
- Matplotlib (Matplotlib licence (based on the Python Software Foundation licence)): https://matplotlib.org/
- NumPy (BSD-3-Clause): https://numpy.org/
- Playwright (Apache-2.0): https://playwright.dev/
- pytest (MIT): https://docs.pytest.org/
- Requests (Apache-2.0): https://requests.readthedocs.io/
- SciPy (BSD-3-Clause): https://scipy.org/
- TypeScript (Apache-2.0): https://www.typescriptlang.org/
- Aladin Lite (not applicable (a link of "Look it up elsewhere", nothing is fetched by this site)): https://aladin.cds.unistra.fr/AladinLite/
- Amazon S3 listing format (ListObjectsV2 answers of the bucket) (An XML namespace name that the bucket's listing carries; nothing is fetched from it): http://s3.amazonaws.com/doc/2006-03-01/
- arXiv, its search interface (The metadata of arXiv is CC0 1.0): https://arxiv.org/
- Backyard Worlds: Planet 9 (not applicable (a link on the "Is it real?" panel, nothing is fetched)): https://www.backyardworlds.org/
- Chromium, as Chrome for Testing (BSD-3-Clause): https://www.chromium.org/
- curl (curl licence (MIT-style)): https://curl.se/
- EPSC 2026 programme, on the Copernicus Meeting Organizer (Free to read; the abstracts are distributed under CC BY 4.0): https://meetingorganizer.copernicus.org/EPSC2026/
- ESA Gaia archive TAP service (ESA Gaia data licence): https://gea.esac.esa.int/tap-server/tap
- faster-whisper (MIT): https://github.com/SYSTRAN/faster-whisper
- FFmpeg 7.1, the essentials build of gyan.dev that imageio-ffmpeg ships (GPL-3.0-or-later (this build)): https://www.gyan.dev/ffmpeg/builds/
- FFmpeg, the build that Playwright installs (version n7.0.1, build 1013) (LGPL-2.1-or-later): https://ffmpeg.org/
- FITS standard, tiled image compression and WCS (SIP convention) (Public specification): https://fits.gsfc.nasa.gov/fits_standard.html
- GAVO Data Center table access (TAP), table gaia.dr3lite (Public service of the German Astrophysical Virtual Observatory; the Gaia data it serves keep the Gaia licence): https://dc.g-vo.org/tap
- Git (GPL-2.0-only): https://git-scm.com/
- GitHub Actions: actions/checkout (MIT): https://github.com/actions/checkout
- GitHub Actions: actions/configure-pages (MIT): https://github.com/actions/configure-pages
- GitHub Actions: actions/deploy-pages (MIT): https://github.com/actions/deploy-pages
- GitHub Actions: actions/setup-node (MIT): https://github.com/actions/setup-node
- GitHub Actions: actions/setup-python (MIT): https://github.com/actions/setup-python
- GitHub Actions: actions/upload-pages-artifact (MIT): https://github.com/actions/upload-pages-artifact
- GitHub Pages (Service under the GitHub Terms of Service): https://pages.github.com/
- Google Chrome (Free to use (Google Chrome and ChromeOS Additional Terms of Service)): https://www.google.com/chrome/
- imageio-ffmpeg (BSD-2-Clause): https://github.com/imageio/imageio-ffmpeg
- IRSA image search (SIA) and cutout service for AllWISE (Public service of NASA/IPAC): https://irsa.ipac.caltech.edu/ibe/cutouts.html
- IRSA image search (SIA), collection spherex_dr1 (Public, no usage restrictions (IRSA terms of use)): https://irsa.ipac.caltech.edu/SIA
- IRSA image search (SIA), collection wise_allwise (Public, no usage restrictions (IRSA terms of use)): https://irsa.ipac.caltech.edu/SIA?COLLECTION=wise_allwise
- IRSA SPHEREx Spectrophotometry Tool, help page (Public, no usage restrictions (IRSA terms of use)): https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html
- JPL Horizons (Public service of NASA/JPL): https://ssd.jpl.nasa.gov/horizons/
- Kirkpatrick 2005, "New Spectral Types L and T", Annual Review of Astronomy and Astrophysics 43, 195 (a paper: cited, not copied): https://doi.org/10.1146/annurev.astro.42.053102.134017
- Legacy Survey viewer (not applicable (a link of "Look it up elsewhere", nothing is fetched by this site)): https://www.legacysurvey.org/viewer
- libvpx, the VP9 encoder and decoder inside that FFmpeg (version 1.14.1) (BSD-3-Clause): https://www.webmproject.org/code/
- Lighthouse (Apache-2.0): https://github.com/GoogleChrome/lighthouse
- MAST Gaia DR3 cone search (Public service of the Space Telescope Science Institute): https://mast.stsci.edu/api/v0/
- MAST table access (TAP) to Gaia DR3 (Public service of the Space Telescope Science Institute; the Gaia data it serves keep the Gaia licence): https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3/
- Minor Planet Center (not applicable (a link on the "Is it real?" panel, nothing is fetched)): https://www.minorplanetcenter.net/
- NASA Astrophysics Data System (ADS), its search interface (Free to use under the ADS terms of use; the search interface needs a free account and key): https://ui.adsabs.harvard.edu/
- NASA/IPAC Infrared Science Archive, public bucket nasa-irsa-spherex (Public, no usage restrictions (IRSA terms of use)): https://irsa.ipac.caltech.edu/
- NIST Chemistry WebBook, infrared spectrum of carbon dioxide (a US government work, public domain): https://webbook.nist.gov/chemistry/
- Node.js (MIT): https://nodejs.org/
- npm (Artistic-2.0): https://github.com/npm/cli
- Poppler, pdftotext (GPL-2.0-only or GPL-3.0-only): https://poppler.freedesktop.org/
- Python (PSF-2.0): https://www.python.org/
- Sesame name resolver of the CDS (Centre de Données astronomiques de Strasbourg), mirror at the Center for Astrophysics (Free service, no registration; its answers come from SIMBAD and NED under their own terms): https://vizier.cfa.harvard.edu/viz-bin/Sesame
- Sesame name resolver of the CDS, Strasbourg (Free service, no registration; its answers come from SIMBAD and NED under their own terms): https://cds.unistra.fr/cgi-bin/Sesame
- SIMBAD (mirror at the Center for Astrophysics) (not applicable (a link of "Look it up elsewhere", opened in a new tab, nothing is fetched by this site)): https://simbad.cfa.harvard.edu/simbad/sim-coo
- SIMBAD astronomical database (Free to use, acknowledgement asked for (CDS)): https://simbad.cds.unistra.fr/
- SIMBAD TAP service (CfA mirror) (Free for research use, with acknowledgement): https://simbad.cfa.harvard.edu/simbad/sim-tap
- SIMBAD TAP service (Strasbourg) (Free for research use, with acknowledgement): https://simbad.u-strasbg.fr/simbad/sim-tap
- VizieR (mirror at the Center for Astrophysics) (not applicable (a link of "Look it up elsewhere", nothing is fetched by this site)): https://vizier.cfa.harvard.edu/viz-bin/VizieR
- Whisper medium.en (OpenAI), in the CTranslate2 form of faster-whisper (MIT): https://huggingface.co/Systran/faster-whisper-medium.en
- WiseView (not applicable (a link of "Look it up elsewhere", nothing is fetched by this site)): http://byw.tools/wiseview
- x264, the H.264 encoder inside that FFmpeg (GPL-2.0-or-later): https://www.videolan.org/developers/x264.html
- Archivo (variable font, widths 62 to 125, weights 100 to 900; the file site/fonts/archivo-latin.woff2) (SIL Open Font License 1.1 (OFL-1.1); the licence text is site/fonts/OFL-Archivo.txt): https://github.com/Omnibus-Type/Archivo
- Courier Prime (regular and bold; the files site/fonts/courier-prime-400-latin.woff2 and site/fonts/courier-prime-700-latin.woff2) (SIL Open Font License 1.1 (OFL-1.1); the licence text is site/fonts/OFL-CourierPrime.txt): https://github.com/quoteunquoteapps/CourierPrime
- DejaVu Sans, the typeface that Matplotlib ships and draws text with (DejaVu Fonts licence (free to use, embed and redistribute; based on the Bitstream Vera licence)): https://dejavu-fonts.github.io/
- "The Spitzer Space Telescope and a Survey of Cometary Activity", page of Michael S. P. Kelley, University of Maryland (Freely readable page without a licence statement; one fact is taken from it and no text is copied): https://pages.astro.umd.edu/~mkelley5/science/comae/spitzer-comet-survey/
- Apache License, Version 2.0 (Copied word for word, as the licence is meant to be): https://www.apache.org/licenses/LICENSE-2.0.txt
- Cohen, Wheaton and Megeath 2003, Spectral irradiance calibration in the infrared, AJ 126, 1090 (Published constants (the zero-point flux densities 1594, 1024 and 666.7 Jy of the 2MASS J, H and Ks bands are quoted, with citation; checked on 15 November 2026 against section VI.4a of the 2MASS All-Sky Data Release Explanatory Supplement, https://www.ipac.caltech.edu/2mass/releases/allsky/doc/sec6_4a.html, which gives the same values from this paper)): https://doi.org/10.1086/376474
- Definition of the Flexible Image Transport System (FITS), the FITS Standard (Freely available): https://fits.gsfc.nasa.gov/fits_standard.html
- Explanatory Supplement to the AllWISE Data Release Products (Public document of NASA/IPAC, freely available; one fact is taken from it and no text is copied): https://wise2.ipac.caltech.edu/docs/release/allwise/expsup/
- JSON Schema, draft 2020-12 (Freely available): https://json-schema.org/draft/2020-12
- Kirkpatrick et al. 2021, The Field Substellar Mass Function Based on the Full-sky 20 pc Census of 525 L, T, and Y Dwarfs, ApJS 253, 7 (Published values quoted with citation, as served by SIMBAD (the paper itself was not opened)): https://doi.org/10.3847/1538-4365/abd107
- Lisse et al., SPHEREx Pre-Perihelion Mapping of H2O, CO2 and CO in Interstellar Object 3I/ATLAS, arXiv:2512.07318 (CC BY 4.0): https://arxiv.org/abs/2512.07318
- Lisse et al., SPHEREx Re-Observation of Interstellar Object 3I/ATLAS in December 2025, arXiv:2601.06759 (CC BY 4.0): https://arxiv.org/abs/2601.06759
- Lowell Observatory, "Pluto Discovery Dome" (Facts cited, no text or image copied): https://lowell.edu/campus/pluto-discovery-telescope/
- NIST Chemistry WebBook, carbon dioxide (Public (NIST Standard Reference Data, free to use with citation)): https://webbook.nist.gov/cgi/cbook.cgi?ID=C124389
- Sesame documentation (the address forms of the service and the lines of its answer) (Freely available): https://vizier.cfa.harvard.edu/vizier/doc/sesame.htx
- SPHEREx archive documentation and the FLAGS extension header of the frames (Freely available): https://caltech-ipac.github.io/spherex-archive-documentation/
- SPHEREx archive documentation, data products (Freely available): https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products
- SPHEREx Explanatory Supplement, version 2.1 of 10 November 2026 (Freely available (IRSA terms of use); facts are taken from it and no text is copied): https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf
- SPHEREx mission page of NASA's Jet Propulsion Laboratory (Public page of NASA/JPL-Caltech; two facts are taken from it and no text is copied): https://www.jpl.nasa.gov/missions/spherex/
- Wright et al. 2010, The Wide-field Infrared Survey Explorer (WISE): Mission Description and Initial On-orbit Performance, AJ 140, 1868 (Published value quoted with citation (checked on 15 November 2026 against the paper's abstract in NASA ADS, 2010AJ....140.1868W: angular resolution 6.1, 6.4, 6.5 and 12.0 arcsec in the four bands)): https://doi.org/10.1088/0004-6256/140/6/1868
- 28 single SPHEREx Level 2 frames kept as test files (each with its address in REFERENCES.md of the repository): Public, no usage restrictions
