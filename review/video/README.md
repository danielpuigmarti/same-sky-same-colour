# The demo video

`sheet.png` is the contact sheet of the film: one frame from the middle of each of the nine beats of
[`content/captions.txt`](../../content/captions.txt), taken from the finished file, with the time slot of the beat,
its caption and its line of the storyboard under it. The film itself, `content/out/video/demo.webm`, is not kept in
the repository: one command records it again.

A sheet that opens with a framed "REHEARSAL, NOT THE FILM TO HAND IN" comes from a run whose team is not named (or is
called "Team name" or the like) or whose address is a placeholder (example.org, localhost); the tool says the same on
the console. Only a run with a real `--team` and the public `--address` writes a sheet without the frame. The line
under the title says where the site was served from when it was filmed, and so does the address bar of beat 8: for the
film to hand in, film the public site with `--url`.

## Record again

```
npm run demo -- --url <address of the site> --team "<team name>" --address "<public address, as the last card shows it>"
```

The same as `node tools/demo.mjs ...`. Without `--url` the tool serves `site/` itself while it films. A run takes
about a minute and a quarter and needs:

- the browser and the ffmpeg of the test runner: `npx playwright install chromium ffmpeg`;
- the network: the view of a typed position (beat 8) is read from the archive while it is filmed.

It writes `content/out/video/demo.webm` (1920 by 1080, 29.8 seconds, no sound) and this folder's `sheet.png`, and
ends with 0 only when all of this holds:

- the table of beats at the top of `tools/demo.mjs` is the storyboard, line for line, and each caption is what
  `tools/render-content.mjs` makes of its line, at most 12 words;
- while it was filmed, each beat showed what its line says: the page is asked (the `expect` steps), and a take that
  fails is filmed again, three times at most;
- read back from the finished file with ffmpeg, the film lasts between 29 and 30 seconds, is 1920 by 1080, and has
  the caption of each beat on screen 0.3 seconds after the start of its time slot, in its middle, and 0.3 seconds
  before its end.

## What is filmed

| Beats | Where the picture comes from |
|---|---|
| 1 and 9 | cards drawn by the tool: the name of the project and of the team, and the address |
| 2 to 7 | the pages of the site with the files prepared in `site/data/`, at the speed of the page; beats 2 and 3 (the bars of the swing), 4 and 5 (the comet) and 7 (Epsilon Indi B) are filmed zoomed in (the `zoom` step), so that the figures of the page are large on screen |
| 8 | the viewer on a typed position, with photos read from the SPHEREx archive during the run |

Every figure in a caption is a number of the site (`{{...}}` of `content/captions.txt`) and is also on the page that is on screen in that beat. The two figures of the swing are never in one caption: 11.8 is said of all the photos of one visit, 1.02 of two photos matched in colour.

The pointer, the ring of a press, the caption band and the line with the address are drawn over the page by the
tool; the mouse and the keys under them are real. Where a page has to load, the film is cut; nothing is played
faster than it happened.

## Change it

- When the pages change: the two tables at the top of `tools/demo.mjs`. `ON` names the elements of the pages,
  `BEATS` holds the nine beats with their steps.
- When the storyboard changes: change the beat in `BEATS` with it; the tool stops when the two differ.
- To try one beat without recording the film: `npm run demo -- --team "<team name>" --address "<address>" --part 6 --frames <folder>`.
- To look at one moment of the film: `--frames <folder>` keeps the middle frame of every beat at full size; any
  other moment comes out of the finished file with the ffmpeg of the test runner (in the `ms-playwright` folder of
  the cache of the user):

  ```
  ffmpeg -ss 18.5 -i content/out/video/demo.webm -frames:v 1 -update 1 frame.png
  ```
