# Hum

A quiet desktop app for notes, projects, and todos. Your vault on disk, your shape.

Hum keeps a plain-text vault as the source of truth. Everything you write stays as Markdown files in a folder you own. The app reads and writes those files; it doesn't lock anything inside a database. If you close Hum and open the folder in your editor of choice, your notes are right where you left them.

## The four tabs

- **Write** is the capture surface. A TipTap editor for inbox entries, with `@Project/Note` mentions that route a capture straight into an existing project note.
- **Focus** ranks your projects by gravity (recent activity, open todos, deadlines) and shows the today/week view. You can snooze projects out of focus when they need to wait.
- **Find** is the vault browser. Three collections (Projects, Library, Notes), each with cards, filtering, and a project hub for drilling in.
- **Hum** is the AI surface. Currently resting; will come back in a later build.

## Stack

- Tauri 2 (Rust backend, native window)
- React 19 + TypeScript + Vite
- TipTap for the editor
- Fuse.js for search
- Design tokens for theming (gruvbox, dark, light themes shipped, easy to add more)

## Scripts

```bash
npm run dev          # vite dev server
npm run tauri dev    # full app (rust backend + vite frontend, hot reload)
npm run build        # tsc + vite build
npm run tauri build  # produce installers
npm run lint
```

## Project shape

```
src/                 React frontend
  components/        UI components per tab + shared primitives
  hooks/             useFuseFilter, useScrollFade
  styles/            global.css, components.css, vault-cards.css, project-list.css
  theme/             tokens.css (the design system), theme.ts (theme switcher)
  prefs/             user prefs (synced with the Rust prefs.rs)
src-tauri/           Rust backend
  src/
    lib.rs           tauri command surface
    inbox.rs         capture routing
    hum.rs           AI tool-use loop (dormant until Hum returns)
    todo_parser.rs   todo extraction
    todo_index.rs    todo index + UUID stamping
    note_meta.rs     frontmatter + metadata
    calendar.rs      ICS feed
    vault_manifest.rs project registry
    prefs.rs         settings I/O
```

## Status

Sweden-only beta. Cross-platform installers via GitHub Actions are wired but not yet active. Multi-device sync via Supabase is planned for later; the vault structure is already prepped for it.

## Theming

All colors, sizes, radii, and shadows live as CSS custom properties in `src/theme/tokens.css`. To add a theme, drop a `[data-theme="your-theme"]` block that overrides any subset of the tokens. No hardcoded values in components, so themes apply everywhere at once.
