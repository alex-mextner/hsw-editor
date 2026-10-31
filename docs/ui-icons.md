# Icon buttons

Every icon-only button of the bars and panels is an `IconButton` (`apps/web/src/components/IconButton.tsx`): its label is the accessible name (`aria-label`) and the tooltip (with the
shortcut next to it when there is one, and a longer `description` where the label alone is not enough), in English and Russian from the i18n catalog. Because a
phone has no hover, the **first press of an icon on a device also holds its tooltip open for about 2.6 s** (`iconHints.ts`), showing the label the button had when
it was pressed. The hint ends early on Escape, an outside tap or another tooltip, and is remembered (per label, or per `hintKey` when the label carries a name)
only once it has been on screen, so a press that closes or removes its own button never uses it up. The three menu triggers that cannot be `IconButton`s (language,
more, assistant session) carry `aria-label` and `title`. `iconButtonsAudit.test.ts` fails when an icon-sized `<Button>` lacks either; `iconAudit.test.tsx` checks
the top bar and the viewport toolbar in both languages; `iconHints.test.tsx` covers the hint.

| Where | Icon | Label (en) | Notes |
| --- | --- | --- | --- |
| Viewport toolbar | pointer | Select | |
| | ruler | Measure | the ruler is only the measuring tool |
| | cube / square | Perspective view / Front view | toggles, pressed in front view |
| | maximize | Fit wall to view | |
| | magnet | Snap to honeycomb | |
| Photo bar | camera | Hide photo overlay / Show photo overlay / Overlay a photo of your wall: choose a file | was a crossed-out eye, which read as "something is hidden"; the camera is the photo, the pressed state is on |
| | image+ | Import photo | |
| | crosshair | Calibrate photo | was a second ruler, now distinct from Measure |
| | image / image-off | Hide photo / Show photo | |
| | contrast, eraser, wand, columns, move, rotate, scan, download | contrast, clean background, auto clean, split, move board, roll board, find tools, export | each has its own label |
| Top bar | panel-left, panel-right, bot | Bank, Inspector, Assistant | with shortcuts |
| | undo / redo | Undo / Redo | with shortcuts |
| | triangle-alert | Invalid zones: hint | pressed = marks shown |
| | gauge | Physics: hint | pressed = amber marks shown |
| | image+, download, hard-drive | Import photo, Export wall, Offline storage | |
| | languages, sun / moon, search, ellipsis | Language, Theme, Search commands, More | menu triggers carry `aria-label` + `title` |
| Inspector | rotate left / right, copy, lock, trash | Rotate left / right, Duplicate, Lock / Unlock, Delete | |
| Wall panel | crosshair, camera | Calibrate, Show / Hide photo overlay | same icons as the photo bar |
