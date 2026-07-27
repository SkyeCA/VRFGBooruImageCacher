# VRFG Booru Hangout

An experimental world that allows you to browse random images posted to the VRFG Booru, now with the ability to filter by tags. You know where to ask for the code.

https://vrchat.com/home/world/wrld_0bd2d1d4-884e-41cc-9eee-a55c5fe37b61/info

## Special Booru World Features

### Image Modifier Tags

There are several tags that, when applied to an image, can change how it is rendered in the Booru World.

#### **BRI - Booru Render Instructions**

A tag that provides instructions about how to render an image to the Booru world's custom image display shader. Use this sparingly to improve the viewing experience of photos.

Example: `BRI:Param1:Param2:Param3:Param4`

| Parameter | Range | Description |
| :--- | :--- | :--- |
| **Param1** | -100 to 100 | Brightness percentage increase or decrease over the baseline. |
| **Param2** | 0 to 360 | Rotation of the image in degrees. |
| **Param3** | 0 or 1 | Horizontal flip (1 = true, 0 = false). |
| **Param4** | 0 or 1 | Vertical flip (1 = true, 0 = false). |

> **Note:** You must provide all parameters; simply provide a zero (0) value for those you do not need to change.

#### **side_by_side - Stereoscopic 3D Flag**

Apply this tag to stereoscopic 3D images to tell the Booru world's custom image display shader to render the image in 3D.

---

## Release Log

**2026-05-27**
* Added another anon's wall drawing.
* Added world usage stats.
* Fixed a coding mistake in the Booru cache server; images should load significantly quicker now.

**2026-05-26**
* Added wall drawings from a few anons.
* Implemented persistent toggles (spawn mirror and animated skybox settings are remembered between instances).
* Fixed 'catnip'.
* Added some suggested music to the default BGM rotation.

**2026-05-24**
* Added Booru stats.
* Added spawn and sofa mirrors.
* Implemented a tagging performance fix.
* Made lighting improvements.
* Fixed the countdown overflow.
* Added some plants and moved the audio player.
* Added a painting prefab (only one canvas for now).

**2026-05-21**
* Added a personal remote respawn button.
* Fixed the desync bug.
* Added a resync timeout.
* Fixed tag filtering.
* Applied sky shader tweaks.
* Added pens.
* **Known Issue:** The Scroll View is broken and does not scroll.
* *The new world is still a work in progress!*

**2026-05-20**
* Expanded tag-based rendering instructions functionality.
* Completed a major code rework to make the Booru browser a prefab.
* Made lighting improvements.
* Released the New World!
* Added a new (optional) skybox.
* **Known Issues:** All previous known issues from the last upload remain.

**2026-05-19**
* Enabled the world to use tags as information on how to display images.
* Currently, the tag `B:100` is supported with a range of -100 to 100 for adjusting image brightness.
* Please do not tag images like this yet, as this feature is likely to change.
* **Known Issue:** Clicking the retry button too quickly can cause a desync that requires a rejoin. Wait roughly 3 seconds after clicking retry.
* **Known Issues:** All previous known issues from the last upload remain.

**2026-05-18**
* Made major changes to how image data is stored and fetched.
* Resolved 404 and 403 errors, which should no longer happen.
* Implemented a basic tag search.
* Added new photo collages to the back wall.
* Updated the side wall photos and artwork.
* Relocated the audio player.
* Relocated the keypad.
* Updated the image index to support up to ID 4290.
* **Known Issue:** When you filter by tag, a matching image will load, and then a second will load unprompted.
* **Known Issue:** Light switch levers are missing.

**2026-05-17**
* Wrote a new shader for the TV display material.
* Added support for viewing stereoscopic 3D images.
* Images tagged as 'side_by_side' will render in 3D mode.

**2026-05-15**
* Enabled the returning of images rated unsafe.

**2026-05-13**
* Added a BGM player.
* Added a personal remote control.

**2026-05-12**
* Initial release.