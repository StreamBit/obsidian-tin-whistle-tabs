# Tin Whistle Tabs

Tin Whistle Tabs is an Obsidian plugin that renders compact vertical tin whistle fingering diagrams above note names in fenced code blocks.

````markdown
```tin-whistle-tabs
key: d

g a b a g e
: Mary had a little lamb
g g g | a a a
d+ c#+ b a g
```
````

## Syntax

- Use `tin-whistle-tabs` as the fenced code block language by default.
- Add `key: d` inside a block to select the physical whistle key for that block.
- Notes are absolute note names like `d`, `f#`, `c`, `bb`, or `d+`.
- `+` means the upper octave/register and appears in the reserved octave row.
- Lines starting with `:` or `#` are visible, but ignored by the fingering parser.
- Only standalone notes are parsed, so words like `day` are left alone.

The plugin settings let you change the code block language name, default whistle key, ignored line prefixes, letter size, fingering size, fingering color, note spacing, line spacing, and per-key preferred fingerings with visual examples. Fingerings use your Obsidian accent color by default, but you can choose a custom color and reset back to the theme color later. The display settings include a live preview so you can tune readability without jumping back to a note, and rendered tab lines wrap inside the code block instead of requiring horizontal scrolling.
