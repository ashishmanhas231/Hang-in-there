SPIDEY HANG - HEROES
====================

One folder per hero. The folder name is the name in the menu. Pictures go in by file name:

  hang.png    at rest, or moving slowly                  (the one to start with)
  swing.png   while he is moving
  fly.png     when he is swung up high (over ~45 degrees)
  grab.png    while you drag him with the mouse
  emblem.png  only shown while the folder has no poses yet

Missing poses fall back: grab and fly use swing, swing uses hang.

The line ties on at the middle of the picture's TOP edge. So:
  - a picture of him hanging upside down: just name it hang.png
  - a picture of him holding a line or reaching up with one hand: ties on at the raised hand
  - an upright standing or flying picture that should hang by its feet: add -flip, e.g. hang-flip.png

Best pictures: PNG with a transparent background, the full body, at least 600 pixels tall.
JPG works too, but hangs as a rectangle with its background.

hero.json sets what he hangs from:
  { "line": "web" }      Spider-Man's web
  { "line": "cable" }    steel cable
  { "line": "chain" }    steel chain
  { "line": "lasso" }    glowing golden rope
  { "line": "grapple" }  thin black grapple line
  { "line": "none" }     nothing drawn: he floats and sways

Pictures added while Spidey Hang is running show up within a second. No restart needed.
