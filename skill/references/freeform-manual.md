# Apple Freeform (无边记) — Zero-Exploration Operational Manual

> **Purpose**: Eliminate multi-minute trial-and-error UI probing when manipulating or painting in macOS Apple Freeform (`com.apple.freeform`). Any AI agent using `dsh-super-computer-use` should read this manual directly instead of re-probing toolbars, popovers, brush widths, color/opacity dialogs, or zoom coordinate transforms.

---

## 1. Spatial UI Zone Map (`cu_discover` Ground Truth)

For a standard normalized Freeform window (`x: 16, y: 34, width: 1360, height: 960`):

| UI Zone | AX Role / Identifier | Screen Bounds (`1360×960` @ `16,34`) | Key Controls & Notes |
| :--- | :--- | :--- | :--- |
| **Top Toolbar** | `AXToolbar` | `y: 34..86` (`h: 52pt`) | `AXCheckBox "Drawing Tools"` (`@527,52`), `AXButton "Add shape"`, `AXButton "New Board"` |
| **Drawing Banner** | `AXGroup` (below toolbar when `Drawing Tools` is checked) | `y: 86..138` | `AXButton "Drawing tool"` (`@702,113`, `value`: active tool name), `AXColorWell "Choose a color"` (`@740,113`, `24×24pt`) |
| **Canvas Viewport** | `AXScrollArea` | `x: 16, y: 86, w: 1360, h: 908` | **Zoom Pivot Center**: `C = (696, 540)` (`16 + 1360/2, 86 + 908/2`). Safe drawable inset: `insetTop = 56pt`, `insetRight = 24pt`, `insetBottom = 72pt` |
| **Bottom-Left Zoom & Minimap** | `AXGroup` overlay inside `AXScrollArea` | `x: 32..195, y: 944..978` | `AXMenuButton` (`"100%"`, `"200%"`, `"300%"`, `"400%"`), `AXButton "Zoom out"`, `AXButton "Zoom in"`, `AXButton "Mini Map"` |
| **Colors Panel** (`axOnly` Floating Window) | `AXWindow` (`subrole: "AXFloatingWindow"`, `title: "Colors"`, `windowId: 0`) | Floating (does NOT appear in board window `cu_snapshot`) | Contains `RGB Sliders` (`Red`, `Green`, `Blue`, `Hex Color #`) + **`Opacity` slider & text field (`0%`–`100%`)** |

---

## 2. Drawing Tools & Exact Brush Width Calibration Table (100% Zoom)

Clicking `AXButton "Drawing tool"` opens an `AXPopover` containing:
- **5 stroke width buttons** at the top (`Extra-fine`, `Fine`, `Medium`, `Heavy`, `Extra-heavy`), **except** when `Fill` or `Lasso` is selected (which hides the 5 width buttons!).
- **10 tool checkboxes** (`AXCheckBox`) below: `Pen`, `Monoline`, `Fountain Pen`, `Watercolor`, `Crayon`, `Reed`, `Pencil`, `Marker`, `Fill`, `Eraser`, `Lasso`.

> **CRITICAL RULE — Never Click Tool Checkboxes by Positional Index**:
> Because selecting `Fill` hides the 5 width buttons, every subsequent tool's index shifts by `-5`. Always match the tool by `node.role === "AXCheckBox" && node.title === "<ToolName>"` (or AppleScript `first checkbox whose description is "<ToolName>"`), and match width by `first button whose description is "<WidthName>"`.

### Verified Physical Stroke Width (`brushWidth` in Screen Points at `100%` Zoom)

| Tool (`expectedTool`) | `Extra-fine` | `Fine` | `Medium` | `Heavy` | `Extra-heavy` | Opacity / Texture Profile & Best Use |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **`Monoline`** | **`2pt`** | **`3pt`** | **`5pt`** | **`7pt`** | **`9pt`** | Uniform width, crisp anti-aliased edge. Supports **100% opaque** or **translucent (`5%–95%`)** glazing. Primary tool for clean contours, shading bands, and details. |
| **`Pen`** | **`3pt`** | **`3pt`** | **`3pt`** | **`4pt`** | **`5pt`** | Speed-modulated ink line (`3–5pt`). Best for dynamic sketching and comic ink lines. |
| **`Fountain Pen`** | `2pt` | `2.5pt` | **`3.5pt`** | `5pt` | `7pt` | Direction-sensitive calligraphic nib (`2–5pt` along stroke). Best for expressive varied-width linework. |
| **`Pencil`** | `2.5pt` | **`4pt`** | `6pt` | `8pt` | `10pt` | Textured graphite grain (`~32%` mean alpha, `~60%` peak). Best for rough under-sketches and dry texture. |
| **`Watercolor`** | **`12pt`** | **`22pt`** | **`36pt`** | `48pt` | `60pt` | Soft wet-edge translucent wash (`expectedOpacity: 0.25..0.55`). Multiplies/darkens over existing pigment; best for soft atmospheric gradients on light grounds. |
| **`Marker`** | **`10pt`** | **`18pt`** | `28pt` | `38pt` | `50pt` | Broad chisel Copic-style marker (`~45%` native translucency; stacks on overlap). Best for architectural/industrial rendering blocks. |
| **`Crayon`** | `6pt` | `9pt` | **`12pt`** | `16pt` | `22pt` | Wax grain texture with paper tooth gaps. Best for textured highlights or children's book illustration styles. |
| **`Reed`** | `3pt` | `5pt` | `8pt` | `12pt` | `16pt` | Angular calligraphic reed pen with dry-brush edge. |
| **`Fill`** | *(N/A)* | *(N/A)* | *(N/A)* | *(N/A)* | *(N/A)* | Closed-lasso interior flood fill (`fill: true` in `cu_paint`). Supports both **100% flat base blocking** and **translucent (`expectedOpacity: 0.20..0.75`) color overlays**. |

---

## 3. Setting Color (`Hex`) & Translucent Opacity (`0%–100%`) Without UI Exploration

Freeform's `AXColorWell "Choose a color"` (`@740,113`) opens a quick 5×6 palette popover, which also has a rainbow circle button (`Show Colors`) that opens macOS's standard `Colors` floating window (`AXFloatingWindow "Colors"`).

### 3.1 Critical Trap: The Tool-Reset Side Effect
Whenever you modify `Hex Color #` or `Opacity` inside the `Colors` floating window, **Freeform automatically exits the active drawing brush and resets to the Selection tool** (`Drawing tool` becomes unchecked or stops drawing).

### 3.2 Deterministic One-Shot Color + Opacity + Tool Re-Arm Recipe
Always set color, opacity, tool, and width in a single deterministic sequence (and close `"Colors"` before painting so it never occludes the canvas):

```applescript
tell application "System Events"
  tell process "Freeform"
    set frontmost to true
    set mainWin to first window whose subrole is "AXStandardWindow"
    -- 1. Ensure Drawing Tools banner is open
    set dtCheck to first checkbox of toolbar 1 of mainWin whose description is "Drawing Tools"
    if (value of dtCheck as integer) is 0 then click dtCheck
    delay 0.15

    -- 2. Ensure Colors panel is open in RGB Sliders mode
    if not (exists (first window whose title is "Colors")) then
      click (first color well of mainWin whose description is "Choose a color")
      delay 0.2
      try
        click (first button of popover 1 of (first color well of mainWin whose description is "Choose a color"))
        delay 0.25
      end try
    end if
    set colorWin to first window whose title is "Colors"
    try
      click (second button of toolbar 1 of colorWin) -- Color Sliders tab
      delay 0.1
      set pUp to first pop up button of splitter group 1 of colorWin
      if value of pUp is not "RGB Sliders" then
        click pUp
        delay 0.1
        click menu item "RGB Sliders" of menu 1 of pUp
        delay 0.15
      end if
    end try

    -- 3. Set 6-digit Hex Color (text field 4) and Opacity % (text field 5 / slider 4)
    set sg to splitter group 1 of colorWin
    set hexField to text field 4 of sg
    set focused of hexField to true
    set value of hexField to "629EFF"
    key code 36 -- Return commits Hex
    delay 0.12

    set opField to text field 5 of sg -- "Opacity" ("0%".."100%")
    set focused of opField to true
    set value of opField to "45%"
    key code 36 -- Return commits Opacity
    delay 0.12

    -- 4. Close Colors window so it never blocks the canvas
    click (first button of colorWin whose subrole is "AXCloseButton")
    delay 0.15

    -- 5. Re-arm Drawing tool + select Tool & Width by description
    set drawBtn to first button of mainWin whose description is "Drawing tool"
    click drawBtn
    delay 0.2
    -- Click again if first click only re-armed the tool without opening the popover
    if not (exists popover 1 of drawBtn) then
      click drawBtn
      delay 0.25
    end if
    set pop to popover 1 of drawBtn
    click (first checkbox of pop whose description is "Monoline")
    delay 0.12
    click (first button of pop whose description is "Extra-fine")
    delay 0.12
    -- Dismiss popover by clicking Drawing tool button once more (Verify value == "Monoline")
    if (exists popover 1 of drawBtn) then click drawBtn
  end tell
end tell
```

---

## 4. Curve Trajectories (`curve`) & Layer Color Blending (`expectedOpacity`)

### 4.1 Smooth Spline & Bézier Curves (`cu_paint`, `cu_cdp_paint`, `cu_drag`)
Humans do not draw eyelashes, pupils, cheek contours, or waves as jagged straight-line polygons. Pass `"curve": "catmull-rom"` or `"curve": "bezier"`:
- **`"catmull-rom"`** *(Recommended for natural drawing)*: Centripetal Catmull-Rom spline ($\alpha = 0.5$) that **passes smoothly through every waypoint** in your stroke array with $C^1$ continuous tangent and zero self-intersection loops on sharp turns. You only need `4–8` key anatomical waypoints along a curve, and `cu_paint` / `cu` automatically subdivides it into a dense, smooth trajectory.
- **`"bezier"`**: Evaluates 3-point strokes as quadratic Bézier curves, $(3k+1)$-point strokes as composite cubic Bézier segments, and arbitrary $N$-point strokes as smooth midpoint-bridged quadratic B-splines.
- **Per-stroke override**: Inside `strokesFile`, `strokes` can mix raw point arrays and per-stroke objects:
  ```json
  {
    "curve": "catmull-rom",
    "strokes": [
      [[610, 420], [635, 408], [662, 412], [685, 426]],
      { "curve": "linear", "points": [[610, 450], [685, 450]] }
    ]
  }
  ```
- **General Desktop Drag (`cu_drag`)**: `cu_drag` also accepts `path: [[x1,y1], [x2,y2], ...]` and `curve: "catmull-rom" | "bezier"` for smooth multi-waypoint drags across any macOS app.

### 4.2 Translucent Glazing & Multi-Layer Color Overlays (`expectedOpacity`)
When painting with `< 100%` opacity in Freeform (e.g., `40%` opacity blush glaze, `35%` eye shadow wash, `50%` translucent color overlay):
- Pass `expectedOpacity: 0.40` (or `40`) in `cu_paint`.
- `cu_paint` verifies both the Freeform toolbar swatch (`Choose a color` composited over the toolbar background) and the canvas stroke pixels using **Porter-Duff source-over alpha compositing**:
  $$C_{\text{expected}} = \alpha \cdot C_{\text{brush}} + (1 - \alpha) \cdot C_{\text{before}}$$
- This allows stacking translucent glazes over existing colors (multi-layer color blending) while keeping strict pixel verification active.

---

## 5. Exact Zoom Coordinate Transform (`100%` ↔ `200%` / `300%` / `400%`)

To paint sub-pixel details (such as `0.67pt` hair strands, iris rings, or specular catchlights), zoom the Freeform board to `200%`, `300%`, or `400%`.

### 5.1 Fixed Zoom Center Formula
Freeform zooms strictly around the center of `AXScrollArea`:
- Let `AXScrollArea` have origin $(x_s, y_s)$ and size $(w_s, h_s)$, so its screen center is:
  $$C = (c_x, c_y) = \left(x_s + \frac{w_s}{2},\; y_s + \frac{h_s}{2}\right)$$
  *(For standard window `16,34 1360×960`, `AXScrollArea` is `16,86 1360×908`, so $C = (696, 540)$.)*
- When changing zoom from $100\%$ ($Z = 1.0$) to zoom factor $Z \in \{1.5, 2.0, 3.0, 4.0\}$ without panning the scrollbars, any $100\%$-canvas point $P_{1x} = (x, y)$ maps to screen coordinate:
  $$P_{\text{screen}}(Z) = C + Z \cdot (P_{1x} - C)$$
- And a brush with physical screen width $W_{\text{screen}}$ (e.g. `Monoline Extra-fine` = `2pt`) produces an effective artwork stroke width of:
  $$W_{1x} = \frac{W_{\text{screen}}}{Z}$$
  *(At `300%` zoom, `Monoline Extra-fine` paints a crisp `0.67pt` micro-line!)*

---

## 6. Layer Z-Ordering (`Arrange -> Send to Back / Bring to Front`)

Freeform groups contiguous strokes into selectable `Drawing` objects on the board:
1. Uncheck `AXCheckBox "Drawing Tools"` (or press `Esc`) to enter Selection mode.
2. Click (`cu_click`) directly on a painted stroke belonging to the target `Drawing` cluster.
3. Use macOS Menu Bar `Arrange`:
   - `Arrange -> Send to Back` (`Shift+Cmd+[`) — sends an underpainting or background fill behind earlier line-art.
   - `Arrange -> Send Backward` (`Cmd+[`)
   - `Arrange -> Bring Forward` (`Cmd+]`)
   - `Arrange -> Bring to Front` (`Shift+Cmd+]`)

---

## 7. Standard 4-Stage Human Painting SOP in Freeform

When asked to paint a complex illustration or portrait in Freeform like a human artist:
1. **Stage 1 — Proportional Construction & Structural Sketch (`Pencil Fine 4pt` or `Monoline Extra-fine 2pt`, `expectedOpacity: 0.35..0.50`)**:
   - Map key anatomical landmarks from the reference image into canvas coordinates and sketch smooth construction curves (`curve: "catmull-rom"`).
2. **Stage 2 — Base Color Blocking & Translucent Underpainting (`Fill` or `Monoline Heavy 7pt` / `Extra-heavy 9pt`)**:
   - Lay down major silhouette color regions (`verifyMode: "aggregate"`), using `Send to Back` if needed so construction guides stay visible.
3. **Stage 3 — Multi-Layer Translucent Glazing & Form Shading (`Monoline Medium 5pt` / `Heavy 7pt` or `Watercolor`, `expectedOpacity: 0.25..0.60`, `curve: "catmull-rom"`)**:
   - Build soft shadow transitions, warm blush gradients, and ambient occlusion by layering `< 100%` opacity strokes rather than harsh opaque stripes.
4. **Stage 4 — Crisp Calligraphic Line-Art & Zoomed Micro-Details (`Monoline Extra-fine 2pt` / `Fountain Pen`, `curve: "catmull-rom"`, Zoom `200%–300%` for eyes/features)**:
   - Render final contours, eyelashes, iris gradients, and `100%` opaque specular catchlights.
