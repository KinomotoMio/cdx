# Generating and editing images through Codex

Claude cannot produce raster images; Codex can, with the built-in image tool of the signed-in ChatGPT account. An image request is an ordinary cdx thread whose result is a picture instead of a code change. What you are maintaining is a picture someone will use. It has a purpose and a place it belongs, it may have things that must not change, and it is not done until it sits in that place and you have looked at it.

Use it for bitmaps: photos, illustrations, textures, sprites, product or UI mockups, covers, transparent cutouts, and edits of an existing image. Build SVG, icons that must match an existing set, diagrams and charts in code instead.

## Where the picture lives

Codex saves every generated image under `~/.codex/generated_images/<thread>/`, whatever the thread's directory or sandbox, so a read-only thread is enough. The result's `images` list gives each one's `path`, the `revisedPrompt` Codex actually used, and a `failure` when generation failed. That folder belongs to Codex. Copy the picture to where it will be used: the path the person named, a sensible asset folder in the project, or a scratch directory for exploration. Never let a project refer to a file under `~/.codex`. Keep earlier versions instead of overwriting them, so the person can compare.

A thread's reply can say it made an image when none was made. Only an entry in `images` with a `path` counts. When `images` is empty, no picture exists, whatever the text says.

## Describing the picture

Codex reads its own image skill before it generates, and that skill owns the prompt craft: use cases, recipes and edit patterns are in `~/.codex/skills/.system/imagegen/`. Your brief supplies what only you know:

- what the picture is for and where it will appear;
- its subject and style;
- its aspect or orientation;
- any text it must contain, quoted verbatim;
- what must stay unchanged.

Keep the person's specifics as they gave them. Add only details that clearly help, such as framing or level of polish. Do not invent brands, slogans, characters or palettes they did not ask for. Ask for exactly one image per thread, and start one thread for each distinct asset or variant.

For an edit or a style reference, attach the images with `-i` (or `images: [...]` in a script). In the brief, say which attachment is the edit target and which is a reference.

## Iterating

Look at the picture before reporting it; the Read tool displays PNG and JPG. Check the subject, the style, the composition, any text letter by letter, and everything that was meant to stay unchanged. To correct it, `send` the same thread one targeted change and restate what must not change; the thread still has the earlier picture and brief in view. Start a new thread only when the brief itself was wrong. Each generation spends the person's image allowance, so change one thing at a time rather than regenerating at random.

Transparent backgrounds behave unevenly. A fresh generation that asks for a genuinely transparent background (real alpha, no checkerboard, no shadow on a backdrop) has produced real RGBA images. An edit of an already transparent image has come back as RGB with a checkerboard painted into the pixels. Check transparency with `file <image>` (look for RGBA) as well as by eye. If an edit loses it, regenerate from scratch with the change described in the brief.

## When no picture comes back

Whether the tool is present depends on the signed-in account and the model. When `images` stays empty, or Codex says it has no image tool, tell the person what happened and which account and model you used. Do not retry with different wording. Codex's image skill also has an API-key route (`OPENAI_API_KEY`). Mention it, but use it only if the person asks.

The brief and any attached images go to OpenAI. Keep private photos and secrets out unless the person has cleared them.
