/**
 * Local categorized emoji set for the chat composer's emoji panel.
 *
 * Deliberately a hand-curated local dataset rather than a dependency (emoji-mart etc.) — it keeps the
 * bundle small, avoids a framework/React dependency, and gives full control over the glyph set. The
 * swap panel renders it as categorized tabs; the legacy popup fallback renders the first category flat.
 *
 * Glyphs are plain Unicode strings (no shortcodes). Skin-tone variants are omitted to keep the set
 * compact; the platform font renders each codepoint.
 */
export interface EmojiCategory {
  /** Stable id (used as the tab key). */
  readonly id: string;
  /** English display label for the tab (UI text is English — see ui-text-in-english memory). */
  readonly label: string;
  /** Glyphs in display order. */
  readonly icons: readonly string[];
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Smileys & People',
    icons: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚',
      '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
      '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄',
      '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
      '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳',
      '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲',
      '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱',
      '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠',
    ],
  },
  {
    id: 'gestures',
    label: 'Gestures',
    icons: [
      '👍', '👎', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙',
      '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖',
      '👏', '🙌', '👐', '🤲', '🙏', '✍️', '💪', '🦾', '🦿', '🦵',
      '🦶', '👂', '🦻', '👃', '🦷', '🦴', '👀', '👁️', '👅', '👄',
    ],
  },
  {
    id: 'hearts',
    label: 'Hearts & Symbols',
    icons: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️',
      '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️',
      '🗨️', '🗯️', '💭', '💤', '✅', '❌', '❓', '❗', '➕', '➖',
    ],
  },
  {
    id: 'animals',
    label: 'Animals & Nature',
    icons: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
      '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒',
      '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇',
      '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜',
      '🌸', '🌼', '🌻', '🌹', '🌺', '🌷', '🌱', '🌲', '🌳', '🍀',
    ],
  },
  {
    id: 'food',
    label: 'Food & Drink',
    icons: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
      '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑',
      '🥦', '🥬', '🥒', '🌶️', '🌽', '🥕', '🥔', '🍠', '🧄', '🧅',
      '🍞', '🥐', '🥖', '🧀', '🥚', '🍳', '🧇', '🥞', '🍔', '🍟',
      '🍕', '🌭', '🥪', '🌮', '🌯', '🍜', '🍝', '🍣', '🍱', '🍚',
    ],
  },
  {
    id: 'activities',
    label: 'Activities',
    icons: [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
      '🏓', '🏸', '🥅', '🏒', '🏑', '🥍', '🏏', '⛳', '🏹', '🎣',
      '🥊', '🥋', '🎽', '⛸️', '🥌', '🛷', '🎿', '⛷️', '🏂', '🏋️',
      '🎯', '🎮', '🎰', '🎲', '🧩', '🎭', '🎨', '🎤', '🎧', '🎹',
    ],
  },
  {
    id: 'travel',
    label: 'Travel & Weather',
    icons: [
      '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐',
      '🚚', '🚛', '🚜', '🛵', '🏍️', '🚲', '🛴', '🚨', '🚀', '✈️',
      '🛩️', '🚁', '🚂', '🚆', '🚊', '🚇', '🚢', '⛵', '🚤', '🗺️',
      '☀️', '🌤️', '⛅', '🌥️', '☁️', '🌦️', '🌧️', '⛈️', '🌩️', '❄️',
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
    icons: [
      '⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💽', '💾', '💿',
      '📷', '📸', '📹', '🎥', '📺', '📻', '🎙️', '⏰', '⏱️', '🔭',
      '💡', '🔦', '🕯️', '🔋', '🔌', '🛠️', '🔨', '⚒️', '🔧', '🧰',
      '🔑', '🗝️', '🔒', '🔓', '🔔', '🔕', '📌', '📎', '✂️', '📦',
    ],
  },
  {
    id: 'flags',
    label: 'Flags',
    icons: [
      '🏳️', '🏴', '🏁', '🚩', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️',
      '🇨🇳', '🇭🇰', '🇹🇼', '🇯🇵', '🇰🇷', '🇺🇸', '🇬🇧', '🇨🇦', '🇦🇺',
      '🇫🇷', '🇩🇪', '🇮🇹', '🇪🇸', '🇵🇹', '🇷🇺', '🇧🇷', '🇮🇳', '🇸🇬', '🇲🇾',
      '🇹🇭', '🇻🇳', '🇮🇩', '🇵🇭', '🇸🇦', '🇦🇪', '🇪🇬', '🇿🇦', '🇲🇽', '🇦🇷',
    ],
  },
];

/** Flat ordered list of every glyph (for the popup fallback that shows everything in one grid). */
export const EMOJIS_FLAT: readonly string[] = EMOJI_CATEGORIES.flatMap((c) => c.icons);
