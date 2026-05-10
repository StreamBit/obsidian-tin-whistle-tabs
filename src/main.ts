import {
  App,
  ButtonComponent,
  ColorComponent,
  DropdownComponent,
  MarkdownPostProcessorContext,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SliderComponent,
  TFile,
  TextComponent
} from "obsidian";

const DEFAULT_CODE_BLOCK_LANGUAGE = "tin-whistle-tabs";
const DEFAULT_IGNORED_PREFIXES = [":", "#", "lyrics:"];
const DEFAULT_LETTER_SIZE_PX = 18;
const DEFAULT_FINGERING_SIZE_PX = 6;
const DEFAULT_NOTE_SPACING_PX = 28;
const DEFAULT_LINE_SPACING_PX = 6;
const MIN_LETTER_SIZE_PX = 12;
const MAX_LETTER_SIZE_PX = 32;
const MIN_FINGERING_SIZE_PX = 4;
const MAX_FINGERING_SIZE_PX = 14;
const MIN_NOTE_SPACING_PX = 4;
const MAX_NOTE_SPACING_PX = 72;
const MIN_LINE_SPACING_PX = 0;
const MAX_LINE_SPACING_PX = 32;
const KEY_NAMES = [
  "C",
  "C#",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B"
] as const;

type WhistleKey = (typeof KEY_NAMES)[number];
type HoleState = "closed" | "open" | "half";

interface FingeringVariant {
  id: string;
  name: string;
  holes: HoleState[];
}

interface GeneratedNote {
  noteKey: string;
  label: string;
  pc: number;
  offset: number;
  isUpper: boolean;
  variants: FingeringVariant[];
}

interface TinWhistleTabsSettings {
  codeBlockLanguage: string;
  defaultKey: WhistleKey;
  ignoredLinePrefixes: string[];
  letterSizePx: number;
  noteSizePx?: number;
  fingeringSizePx: number;
  fingeringColor: string | null;
  noteSpacingPx: number;
  lineSpacingPx: number;
  fingeringPreferences: Record<string, Record<string, string>>;
}

interface ParsedBlock {
  key: string | null;
  renderedLines: string[];
}

interface ParsedNoteToken {
  token: string;
  pc: number | null;
  isUpper: boolean;
  invalidReason?: string;
}

interface ResolvedFingering {
  note: GeneratedNote | null;
  variant: FingeringVariant | null;
  warning: string | null;
}

const DEFAULT_SETTINGS: TinWhistleTabsSettings = {
  codeBlockLanguage: DEFAULT_CODE_BLOCK_LANGUAGE,
  defaultKey: "D",
  ignoredLinePrefixes: DEFAULT_IGNORED_PREFIXES,
  letterSizePx: DEFAULT_LETTER_SIZE_PX,
  fingeringSizePx: DEFAULT_FINGERING_SIZE_PX,
  fingeringColor: null,
  noteSpacingPx: DEFAULT_NOTE_SPACING_PX,
  lineSpacingPx: DEFAULT_LINE_SPACING_PX,
  fingeringPreferences: {}
};

const KEY_TO_PC: Record<WhistleKey, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  Ab: 8,
  A: 9,
  Bb: 10,
  B: 11
};

const NOTE_BASE_PC: Record<string, number> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11
};

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const FLAT_KEYS = new Set<WhistleKey>(["F", "Bb", "Eb", "Ab", "Db", "Gb"]);
const PLAYABLE_OFFSETS = [0, 2, 3, 4, 5, 6, 7, 9, 10, 11];

const STANDARD_FINGERINGS: Record<number, HoleState[]> = {
  0: ["closed", "closed", "closed", "closed", "closed", "closed"],
  2: ["closed", "closed", "closed", "closed", "closed", "open"],
  3: ["closed", "closed", "closed", "closed", "half", "open"],
  4: ["closed", "closed", "closed", "closed", "open", "open"],
  5: ["closed", "closed", "closed", "open", "open", "open"],
  6: ["closed", "closed", "half", "open", "open", "open"],
  7: ["closed", "closed", "open", "open", "open", "open"],
  9: ["closed", "open", "open", "open", "open", "open"],
  10: ["open", "closed", "closed", "open", "open", "open"],
  11: ["open", "open", "open", "open", "open", "open"]
};

const HIGH_ROOT_VENT: HoleState[] = ["open", "closed", "closed", "closed", "closed", "closed"];
const CNATURAL_HALF_HOLE: HoleState[] = ["half", "open", "open", "open", "open", "open"];
const CSHARP_BOTTOM_COVERED: HoleState[] = ["open", "open", "open", "open", "open", "closed"];
const GSHARP_CROSS_FINGER: HoleState[] = ["closed", "closed", "open", "closed", "closed", "open"];

export default class TinWhistleTabsPlugin extends Plugin {
  settings: TinWhistleTabsSettings;
  private registeredLanguages = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerTinWhistleLanguage(DEFAULT_CODE_BLOCK_LANGUAGE);
    this.registerTinWhistleLanguage(this.settings.codeBlockLanguage);

    this.addSettingTab(new TinWhistleTabsSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<TinWhistleTabsSettings> | null;
    this.settings = normalizeSettings(loaded);
  }

  async saveSettings(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  registerTinWhistleLanguage(language: string): void {
    const trimmed = language.trim() || DEFAULT_CODE_BLOCK_LANGUAGE;
    const normalized = trimmed.toLowerCase();
    if (this.registeredLanguages.has(normalized)) {
      return;
    }

    this.registeredLanguages.add(normalized);
    this.registerMarkdownCodeBlockProcessor(trimmed, (source, el, ctx) => {
      this.renderTinWhistleBlock(source, el, ctx);
    });
  }

  private getRegisteredLanguages(): string[] {
    const languages = new Set<string>([
      DEFAULT_CODE_BLOCK_LANGUAGE,
      this.settings.codeBlockLanguage.trim() || DEFAULT_CODE_BLOCK_LANGUAGE
    ]);
    for (const language of this.registeredLanguages) {
      languages.add(language);
    }

    return Array.from(languages);
  }

  private renderTinWhistleBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ): void {
    const parsed = parseBlock(source);
    const selectedKey = normalizeKey(parsed.key) ?? this.settings.defaultKey;
    const invalidKey = parsed.key !== null && normalizeKey(parsed.key) === null;

    el.empty();
    el.addClass("twt-container");
    applyDisplaySettings(el, this.settings);

    const toolbar = el.createDiv({ cls: "twt-toolbar" });

    if (invalidKey) {
      toolbar.createSpan({
        cls: "twt-block-warning",
        text: `Invalid key "${parsed.key}"; using ${selectedKey}`
      });
    }

    const select = toolbar.createEl("select", { cls: "dropdown twt-key-select" });
    for (const key of KEY_NAMES) {
      const option = select.createEl("option", { text: key });
      option.value = key;
      option.selected = key === selectedKey;
    }

    select.addEventListener("change", async () => {
      const nextKey = normalizeKey(select.value);
      if (!nextKey) {
        return;
      }

      try {
        await this.writeKeyToCodeBlock(ctx, el, nextKey, source);
      } catch (error) {
        console.error("Unable to update tin whistle tab key", error);
        new Notice("Unable to update this tin whistle tab key.");
      }
    });

    const linesEl = el.createDiv({ cls: "twt-lines" });
    for (const line of parsed.renderedLines) {
      this.renderLine(linesEl, line, selectedKey);
    }
  }

  renderLine(parent: HTMLElement, line: string, key: WhistleKey): void {
    if (line.trim() === "") {
      parent.createDiv({ cls: "twt-blank-line" });
      return;
    }

    const ignored = getIgnoredPrefix(line, this.settings.ignoredLinePrefixes);
    if (ignored !== null) {
      parent.createDiv({
        cls: "twt-ignored-line",
        text: stripIgnoredPrefix(line, ignored)
      });
      return;
    }

    const lineEl = parent.createDiv({ cls: "twt-music-line" });
    const segments = parseMusicLine(line);

    for (const segment of segments) {
      if (typeof segment === "string") {
        lineEl.createSpan({ cls: "twt-spacer", text: segment });
        continue;
      }

      const resolved = this.resolveFingering(segment, key);
      const noteCell = lineEl.createSpan({ cls: "twt-note-cell" });
      noteCell.style.setProperty("--twt-token-length", String(segment.token.length));

      if (resolved.warning) {
        renderDiagram(noteCell, null, segment.isUpper, resolved.warning);
      } else if (resolved.variant) {
        renderDiagram(noteCell, resolved.variant, segment.isUpper, resolved.variant.name);
      }

      noteCell.createSpan({ cls: "twt-note-label", text: segment.token });
    }
  }

  private resolveFingering(token: ParsedNoteToken, key: WhistleKey): ResolvedFingering {
    if (token.pc === null) {
      return {
        note: null,
        variant: null,
        warning: token.invalidReason ?? `Invalid note "${token.token}"`
      };
    }

    const note = getNotesForKey(key).find(
      (candidate) => candidate.pc === token.pc && candidate.isUpper === token.isUpper
    );

    if (!note) {
      return {
        note: null,
        variant: null,
        warning: `No fingering for ${token.token} on ${key} whistle`
      };
    }

    const preference = this.settings.fingeringPreferences[key]?.[note.noteKey];
    const variant = note.variants.find((candidate) => candidate.id === preference) ?? note.variants[0];

    return {
      note,
      variant,
      warning: null
    };
  }

  private async writeKeyToCodeBlock(
    ctx: MarkdownPostProcessorContext,
    el: HTMLElement,
    key: WhistleKey,
    originalSource: string
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) {
      throw new Error("Tin whistle tab key can only be updated in vault files.");
    }

    const content = await this.app.vault.read(file);
    const nextContent =
      this.replaceKeyUsingSectionInfo(content, ctx, el, key) ??
      this.replaceKeyUsingSourceSearch(content, originalSource, key);

    if (nextContent === null || nextContent === content) {
      throw new Error("Could not locate the source code block to update.");
    }

    await this.app.vault.modify(file, nextContent);
  }

  private replaceKeyUsingSectionInfo(
    content: string,
    ctx: MarkdownPostProcessorContext,
    el: HTMLElement,
    key: WhistleKey
  ): string | null {
    const section = ctx.getSectionInfo(el);
    if (!section) {
      return null;
    }

    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, section.lineStart);
    const end = Math.min(lines.length - 1, section.lineEnd);
    const fence = findFence(lines, start, end, this.getRegisteredLanguages());

    if (!fence) {
      return null;
    }

    const nextBody = upsertKeyLine(lines.slice(fence.openLine + 1, fence.closeLine), key);
    lines.splice(fence.openLine + 1, fence.closeLine - fence.openLine - 1, ...nextBody);
    return lines.join(eol);
  }

  private replaceKeyUsingSourceSearch(content: string, originalSource: string, key: WhistleKey): string | null {
    const languages = this.getRegisteredLanguages();
    const escapedLanguages = languages.map(escapeRegExp).join("|");
    const fenceRegex = new RegExp(
      `(^|\\n)(\\\`{3,}|~{3,})\\s*(${escapedLanguages})([^\\n]*)\\n([\\s\\S]*?)\\n\\2(?=\\n|$)`,
      "gi"
    );
    const eol = content.includes("\r\n") ? "\r\n" : "\n";

    for (const match of content.matchAll(fenceRegex)) {
      const body = match[5];
      if (body !== originalSource || match.index === undefined) {
        continue;
      }

      const nextBody = upsertKeyLine(body.split(/\r?\n/), key).join(eol);
      const replacement = `${match[1]}${match[2]} ${match[3]}${match[4]}${eol}${nextBody}${eol}${match[2]}`;
      return `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
    }

    return null;
  }
}

class TinWhistleTabsSettingTab extends PluginSettingTab {
  plugin: TinWhistleTabsPlugin;
  selectedKey: WhistleKey;

  constructor(app: App, plugin: TinWhistleTabsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.selectedKey = plugin.settings.defaultKey;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Tin Whistle Tabs" });

    new Setting(containerEl)
      .setName("Code block language")
      .setDesc("The word to type after the opening backticks to make a tin whistle tab block.")
      .addText((text: TextComponent) => {
        text
          .setPlaceholder(DEFAULT_CODE_BLOCK_LANGUAGE)
          .setValue(this.plugin.settings.codeBlockLanguage)
          .onChange(async (value) => {
            this.plugin.settings.codeBlockLanguage = value.trim() || DEFAULT_CODE_BLOCK_LANGUAGE;
            this.plugin.registerTinWhistleLanguage(this.plugin.settings.codeBlockLanguage);
            await this.plugin.saveSettings();
            new Notice("New tin whistle code block language is active.");
          });
      });

    new Setting(containerEl)
      .setName("Default whistle key")
      .setDesc("Used when a tin whistle tab block does not include a valid key line.")
      .addDropdown((dropdown: DropdownComponent) => {
        addKeyOptions(dropdown);
        dropdown.setValue(this.plugin.settings.defaultKey);
        dropdown.onChange(async (value) => {
          const key = normalizeKey(value);
          if (!key) {
            return;
          }

          this.plugin.settings.defaultKey = key;
          this.selectedKey = key;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Ignored line prefixes")
      .setDesc("Lines that start with these characters are shown as text only, so lyrics are not treated as notes. Separate multiple prefixes with commas.")
      .addText((text: TextComponent) => {
        text
          .setPlaceholder(DEFAULT_IGNORED_PREFIXES.join(", "))
          .setValue(this.plugin.settings.ignoredLinePrefixes.join(", "))
          .onChange(async (value) => {
            const prefixes = value
              .split(",")
              .map((prefix) => prefix.trim())
              .filter(Boolean);
            this.plugin.settings.ignoredLinePrefixes = prefixes.length > 0 ? prefixes : DEFAULT_IGNORED_PREFIXES;
            await this.plugin.saveSettings();
          });
      });

    this.renderDisplaySettings(containerEl);

    containerEl.createEl("h3", { text: "Preferred fingerings" });

    const keybar = containerEl.createDiv({ cls: "twt-settings-keybar" });
    keybar.createSpan({ text: "Whistle key" });
    const keySelect = new DropdownComponent(keybar);
    addKeyOptions(keySelect);
    keySelect.setValue(this.selectedKey);
    keySelect.onChange((value) => {
      const key = normalizeKey(value);
      if (!key) {
        return;
      }

      this.selectedKey = key;
      this.display();
    });

    const resetActions = containerEl.createDiv({ cls: "twt-reset-actions" });
    new ButtonComponent(resetActions)
      .setButtonText("Reset Current Key to Defaults")
      .onClick(async () => {
        delete this.plugin.settings.fingeringPreferences[this.selectedKey];
        ensureFingeringPreferences(this.plugin.settings);
        await this.plugin.saveSettings();
        this.display();
      });
    new ButtonComponent(resetActions)
      .setButtonText("Reset All Fingering Preferences")
      .onClick(async () => {
        this.plugin.settings.fingeringPreferences = {};
        ensureFingeringPreferences(this.plugin.settings);
        await this.plugin.saveSettings();
        this.display();
      });

    const notes = getNotesForKey(this.selectedKey);
    for (const note of notes) {
      this.renderNotePreference(containerEl, note);
    }
  }

  private renderDisplaySettings(parent: HTMLElement): void {
    parent.createEl("h3", { text: "Display" });

    const section = parent.createDiv({ cls: "twt-display-settings" });
    const preview = section.createDiv({ cls: "twt-container twt-settings-preview" });
    applyDisplaySettings(preview, this.plugin.settings);
    this.renderSettingsPreview(preview);

    const updatePreview = (): void => {
      applyDisplaySettings(preview, this.plugin.settings);
    };

    new Setting(section)
      .setName("Letter size")
      .setDesc("Adjusts the note letters under each fingering diagram.")
      .addSlider((slider: SliderComponent) => {
        slider
          .setLimits(MIN_LETTER_SIZE_PX, MAX_LETTER_SIZE_PX, 1)
          .setValue(this.plugin.settings.letterSizePx)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.letterSizePx = value;
            updatePreview();
            await this.plugin.saveSettings();
          });
      });

    new Setting(section)
      .setName("Fingering size")
      .setDesc("Adjusts the size of the fingering holes above each note.")
      .addSlider((slider: SliderComponent) => {
        slider
          .setLimits(MIN_FINGERING_SIZE_PX, MAX_FINGERING_SIZE_PX, 1)
          .setValue(this.plugin.settings.fingeringSizePx)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fingeringSizePx = value;
            updatePreview();
            await this.plugin.saveSettings();
          });
      });

    new Setting(section)
      .setName("Fingering color")
      .setDesc("Uses your Obsidian accent color by default, or a custom color if you choose one.")
      .addColorPicker((color: ColorComponent) => {
        color
          .setValue(this.plugin.settings.fingeringColor ?? getObsidianAccentHex())
          .onChange(async (value) => {
            this.plugin.settings.fingeringColor = value;
            updatePreview();
            await this.plugin.saveSettings();
          });
      })
      .addButton((button: ButtonComponent) => {
        button
          .setButtonText("Use Obsidian Accent Color")
          .onClick(async () => {
            this.plugin.settings.fingeringColor = null;
            updatePreview();
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(section)
      .setName("Note spacing")
      .setDesc("Adjusts the minimum width reserved for each note and fingering.")
      .addSlider((slider: SliderComponent) => {
        slider
          .setLimits(MIN_NOTE_SPACING_PX, MAX_NOTE_SPACING_PX, 1)
          .setValue(this.plugin.settings.noteSpacingPx)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.noteSpacingPx = value;
            updatePreview();
            await this.plugin.saveSettings();
          });
      });

    new Setting(section)
      .setName("Line spacing")
      .setDesc("Adjusts vertical spacing between rendered tab and lyric lines.")
      .addSlider((slider: SliderComponent) => {
        slider
          .setLimits(MIN_LINE_SPACING_PX, MAX_LINE_SPACING_PX, 1)
          .setValue(this.plugin.settings.lineSpacingPx)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.lineSpacingPx = value;
            updatePreview();
            await this.plugin.saveSettings();
          });
      });
  }

  private renderSettingsPreview(parent: HTMLElement): void {
    const lines = parent.createDiv({ cls: "twt-lines" });
    this.plugin.renderLine(lines, "d e f# | g  a  b c#+  d+ e+ f#+ g+", this.plugin.settings.defaultKey);
    this.plugin.renderLine(lines, ": preview lyric line", this.plugin.settings.defaultKey);
  }

  private renderNotePreference(parent: HTMLElement, note: GeneratedNote): void {
    const noteEl = parent.createDiv({ cls: "twt-preference-note" });
    noteEl.createSpan({ cls: "twt-preference-note-name", text: note.label });

    const current = this.plugin.settings.fingeringPreferences[this.selectedKey]?.[note.noteKey] ?? note.variants[0].id;
    const selectedVariant = note.variants.find((variant) => variant.id === current) ?? note.variants[0];

    const choiceList = noteEl.createDiv({ cls: "twt-fingering-choice-list" });
    for (const variant of note.variants) {
      const button = choiceList.createEl("button", {
        cls: `twt-fingering-choice${variant.id === selectedVariant.id ? " is-selected" : ""}`,
        attr: {
          "aria-pressed": variant.id === selectedVariant.id ? "true" : "false",
          type: "button"
        }
      });
      button.createSpan({ cls: "twt-fingering-choice-name", text: variant.name });
      renderDiagram(button, variant, note.isUpper, variant.name);
      button.addEventListener("click", async () => {
        this.plugin.settings.fingeringPreferences[this.selectedKey][note.noteKey] = variant.id;
        await this.plugin.saveSettings();
        this.display();
      });
    }
  }
}

function normalizeSettings(loaded: Partial<TinWhistleTabsSettings> | null): TinWhistleTabsSettings {
  const normalized: TinWhistleTabsSettings = {
    ...DEFAULT_SETTINGS,
    ...loaded,
    defaultKey: normalizeKey(loaded?.defaultKey) ?? DEFAULT_SETTINGS.defaultKey,
    codeBlockLanguage: loaded?.codeBlockLanguage?.trim() || DEFAULT_SETTINGS.codeBlockLanguage,
    ignoredLinePrefixes:
      loaded?.ignoredLinePrefixes?.filter(Boolean) ?? DEFAULT_SETTINGS.ignoredLinePrefixes,
    letterSizePx: clampNumber(
      loaded?.letterSizePx ?? loaded?.noteSizePx,
      MIN_LETTER_SIZE_PX,
      MAX_LETTER_SIZE_PX,
      DEFAULT_LETTER_SIZE_PX
    ),
    fingeringSizePx: clampNumber(
      loaded?.fingeringSizePx,
      MIN_FINGERING_SIZE_PX,
      MAX_FINGERING_SIZE_PX,
      DEFAULT_FINGERING_SIZE_PX
    ),
    fingeringColor: normalizeColor(loaded?.fingeringColor),
    noteSpacingPx: clampNumber(
      loaded?.noteSpacingPx,
      MIN_NOTE_SPACING_PX,
      MAX_NOTE_SPACING_PX,
      DEFAULT_NOTE_SPACING_PX
    ),
    lineSpacingPx: clampNumber(
      loaded?.lineSpacingPx,
      MIN_LINE_SPACING_PX,
      MAX_LINE_SPACING_PX,
      DEFAULT_LINE_SPACING_PX
    ),
    fingeringPreferences: loaded?.fingeringPreferences ?? {}
  };

  ensureFingeringPreferences(normalized);
  return normalized;
}

function ensureFingeringPreferences(settings: TinWhistleTabsSettings): void {
  for (const key of KEY_NAMES) {
    settings.fingeringPreferences[key] = settings.fingeringPreferences[key] ?? {};
    const keyPreferences = settings.fingeringPreferences[key];

    for (const note of getNotesForKey(key)) {
      const current = keyPreferences[note.noteKey];
      const hasCurrent = note.variants.some((variant) => variant.id === current);
      if (!hasCurrent) {
        keyPreferences[note.noteKey] = note.variants[0].id;
      }
    }
  }
}

function parseBlock(source: string): ParsedBlock {
  const renderedLines: string[] = [];
  let key: string | null = null;

  for (const line of source.split(/\r?\n/)) {
    const keyMatch = line.match(/^\s*key\s*:\s*(\S+)\s*$/i);
    if (keyMatch) {
      key = keyMatch[1];
      continue;
    }

    renderedLines.push(line);
  }

  return { key, renderedLines };
}

function parseMusicLine(line: string): Array<string | ParsedNoteToken> {
  const segments: Array<string | ParsedNoteToken> = [];
  let plain = "";
  let index = 0;

  while (index < line.length) {
    const token = readStandaloneNoteToken(line, index);

    if (!token) {
      plain += line[index];
      index += 1;
      continue;
    }

    if (plain.length > 0) {
      segments.push(plain);
      plain = "";
    }

    segments.push(token);
    index += token.token.length;
  }

  if (plain.length > 0) {
    segments.push(plain);
  }

  return segments;
}

function readStandaloneNoteToken(line: string, index: number): ParsedNoteToken | null {
  const first = line[index];
  if (!first || !/[a-zA-Z]/.test(first)) {
    return null;
  }

  if (index > 0 && isNoteBoundaryBlocker(line[index - 1])) {
    return null;
  }

  if (!/[a-gA-G]/.test(first)) {
    return readStandaloneInvalidNoteToken(line, index);
  }

  let cursor = index + 1;
  if (line[cursor] === "#" || line[cursor] === "b") {
    cursor += 1;
  }

  let isUpper = false;
  if (line[cursor] === "+") {
    isUpper = true;
    cursor += 1;
  }

  if (cursor < line.length && isNoteBoundaryBlocker(line[cursor])) {
    return null;
  }

  const parsed = parseNoteToken(line.slice(index, cursor));
  if (!parsed) {
    return readStandaloneInvalidNoteToken(line, index);
  }

  return { ...parsed, isUpper };
}

function readStandaloneInvalidNoteToken(line: string, index: number): ParsedNoteToken | null {
  const match = line.slice(index).match(/^[a-zA-Z][#b+]*/);
  if (!match) {
    return null;
  }

  const token = match[0];
  const nextIndex = index + token.length;
  if (nextIndex < line.length && isNoteBoundaryBlocker(line[nextIndex])) {
    return null;
  }

  const looksLikeMalformedNote = /^[a-gA-G][#b+]{2,}$/.test(token);
  const looksLikeInvalidSingleLetter = token.length === 1 && /^[h-zH-Z]$/.test(token);
  if (!looksLikeMalformedNote && !looksLikeInvalidSingleLetter) {
    return null;
  }

  return {
    token,
    pc: null,
    isUpper: token.endsWith("+"),
    invalidReason: `Invalid note "${token}"`
  };
}

function parseNoteToken(token: string): ParsedNoteToken | null {
  const match = token.match(/^([a-gA-G])([#b]?)(\+?)$/);
  if (!match) {
    return null;
  }

  const note = match[1].toLowerCase();
  const accidental = match[2];
  const basePc = NOTE_BASE_PC[note];
  const modifier = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;

  return {
    token,
    pc: modulo(basePc + modifier, 12),
    isUpper: match[3] === "+"
  };
}

function isNoteBoundaryBlocker(character: string): boolean {
  return /[a-zA-Z0-9#+]/.test(character);
}

function getNotesForKey(key: WhistleKey): GeneratedNote[] {
  const preferFlats = FLAT_KEYS.has(key);
  const root = KEY_TO_PC[key];
  const notes: GeneratedNote[] = [];

  for (const offset of PLAYABLE_OFFSETS) {
    const pc = modulo(root + offset, 12);
    const label = noteNameForPc(pc, preferFlats);
    notes.push(createGeneratedNote(label, pc, offset, false));
  }

  for (const offset of PLAYABLE_OFFSETS) {
    const pc = modulo(root + offset, 12);
    const label = `${noteNameForPc(pc, preferFlats)}+`;
    notes.push(createGeneratedNote(label, pc, offset, true));
  }

  return notes;
}

function createGeneratedNote(label: string, pc: number, offset: number, isUpper: boolean): GeneratedNote {
  return {
    noteKey: label,
    label,
    pc,
    offset,
    isUpper,
    variants: getVariantsForOffset(offset, isUpper)
  };
}

function getVariantsForOffset(offset: number, isUpper: boolean): FingeringVariant[] {
  const standard = STANDARD_FINGERINGS[offset];
  const variants: FingeringVariant[] = [
    {
      id: "standard",
      name: "Standard",
      holes: standard
    }
  ];

  if (isUpper && offset === 0) {
    variants.push({
      id: "top-hole-vent",
      name: "Top-hole vent",
      holes: HIGH_ROOT_VENT
    });
  }

  if (offset === 6) {
    variants.push({
      id: "cross-finger",
      name: "Cross-finger",
      holes: GSHARP_CROSS_FINGER
    });
  }

  if (offset === 10) {
    variants.push({
      id: "half-hole",
      name: "Half-hole",
      holes: CNATURAL_HALF_HOLE
    });
  }

  if (offset === 11) {
    variants.push({
      id: "bottom-covered",
      name: "Bottom covered",
      holes: CSHARP_BOTTOM_COVERED
    });
  }

  return variants;
}

function renderDiagram(
  parent: HTMLElement,
  variant: FingeringVariant | null,
  isUpper: boolean,
  title: string
): void {
  const diagram = parent.createSpan({
    cls: "twt-diagram",
    attr: {
      title
    }
  });

  if (variant) {
    for (const hole of variant.holes) {
      diagram.createSpan({ cls: `twt-hole twt-hole-${hole}` });
    }
  } else {
    for (let index = 0; index < 6; index += 1) {
      if (index === 5) {
        diagram.createSpan({ cls: "twt-hole twt-warning-hole", text: "!" });
      } else {
        diagram.createSpan({ cls: "twt-hole twt-hole-empty" });
      }
    }
  }

  diagram.createSpan({
    cls: "twt-octave-row",
    text: variant && isUpper ? "+" : " "
  });
}

function getIgnoredPrefix(line: string, prefixes: string[]): string | null {
  const trimmedStart = line.trimStart();
  return prefixes.find((prefix) => trimmedStart.toLowerCase().startsWith(prefix.toLowerCase())) ?? null;
}

function stripIgnoredPrefix(line: string, prefix: string): string {
  if (prefix === "#") {
    return line;
  }

  const indentLength = line.length - line.trimStart().length;
  const indent = line.slice(0, indentLength);
  const trimmed = line.trimStart();
  return `${indent}${trimmed.slice(prefix.length).replace(/^\s/, "")}`;
}

function normalizeKey(value: unknown): WhistleKey | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return KEY_NAMES.find((key) => key.toLowerCase() === normalized) ?? null;
}

function noteNameForPc(pc: number, preferFlats: boolean): string {
  return preferFlats ? FLAT_NAMES[pc] : SHARP_NAMES[pc];
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function addKeyOptions(dropdown: DropdownComponent): void {
  for (const key of KEY_NAMES) {
    dropdown.addOption(key, key);
  }
}

function applyDisplaySettings(el: HTMLElement, settings: TinWhistleTabsSettings): void {
  el.style.setProperty("--twt-letter-size", `${settings.letterSizePx}px`);
  el.style.setProperty("--twt-hole-size", `${settings.fingeringSizePx}px`);
  el.style.setProperty("--twt-hole-gap", `${Math.max(1, settings.fingeringSizePx * 0.22).toFixed(1)}px`);
  el.style.setProperty("--twt-octave-size", `${Math.max(10, settings.fingeringSizePx * 1.8).toFixed(1)}px`);
  const fallbackAccent = getObsidianAccentHex();
  if (settings.fingeringColor) {
    el.style.setProperty("--twt-fingering-color", settings.fingeringColor);
    el.style.setProperty("--twt-warning-color", getContrastingColor(settings.fingeringColor));
  } else {
    el.style.removeProperty("--twt-fingering-color");
    el.style.setProperty("--twt-warning-color", getContrastingColor(fallbackAccent));
  }
  el.style.setProperty("--twt-cell-width", `${settings.noteSpacingPx}px`);
  el.style.setProperty("--twt-line-spacing", `${settings.lineSpacingPx}px`);
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function getObsidianAccentHex(): string {
  const accent = getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim();
  return colorToHex(accent) ?? "#7c3aed";
}

function colorToHex(color: string): string | null {
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const value = hexMatch[1];
    if (value.length === 6) {
      return `#${value}`;
    }

    return `#${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`;
  }

  const rgbMatch = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgbMatch) {
    return null;
  }

  return `#${[rgbMatch[1], rgbMatch[2], rgbMatch[3]]
    .map((component) => Number(component).toString(16).padStart(2, "0"))
    .join("")}`;
}

function getContrastingColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.56 ? "#000000" : "#ffffff";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function upsertKeyLine(bodyLines: string[], key: WhistleKey): string[] {
  const nextLines = [...bodyLines];
  const keyLineIndex = nextLines.findIndex((line) => /^\s*key\s*:/i.test(line));
  const keyLine = `key: ${key.toLowerCase()}`;

  if (keyLineIndex >= 0) {
    nextLines[keyLineIndex] = keyLine;
    return nextLines;
  }

  if (nextLines.length === 0 || nextLines[0].trim() === "") {
    nextLines.unshift(keyLine);
    return nextLines;
  }

  nextLines.unshift(keyLine, "");
  return nextLines;
}

function findFence(
  lines: string[],
  start: number,
  end: number,
  languages: string[]
): { openLine: number; closeLine: number } | null {
  for (let index = start; index <= end; index += 1) {
    const openMatch = lines[index].match(/^(\s*)(`{3,}|~{3,})\s*(\S+).*$/);
    if (!openMatch) {
      continue;
    }

    const language = openMatch[3];
    if (!languages.some((candidate) => candidate.toLowerCase() === language.toLowerCase())) {
      continue;
    }

    const fenceMarker = openMatch[2];
    for (let closeLine = index + 1; closeLine <= end; closeLine += 1) {
      if (lines[closeLine].startsWith(fenceMarker)) {
        return { openLine: index, closeLine };
      }
    }
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
