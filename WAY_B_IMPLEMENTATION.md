# WAY B — implementation map

## Scope

WAY B is an isolated visual variant built from commit `ab1d1f8`.
The existing HTML/JavaScript application, Vercel Function API, Neon schema,
authentication flow and persisted data contracts remain unchanged.

The current application is a static HTML/CSS/JavaScript PWA rather than React.
Converting it to React only to match the example TypeScript API would increase
risk without improving the pilot. Reusable components are therefore expressed
through semantic CSS tokens and shared component classes.

## Design tokens

- Background: `--way-bg-primary`, `--way-bg-secondary`, `--way-bg-tertiary`
- Surfaces: `--way-surface-primary`, `--way-surface-secondary`,
  `--way-surface-elevated`, `--way-surface-hover`, `--way-surface-pressed`
- Text: `--way-text-primary`, `--way-text-secondary`, `--way-text-tertiary`,
  `--way-text-disabled`, `--way-text-inverse`
- Brand: `--way-brand-primary`, hover, pressed, muted and border variants
- Border and status colors: semantic variables only
- Spacing: 4/8/12/16/20/24/32/40/48 px
- Radius: 8/12/14/18/24/28/999 px
- Motion: 180–250 ms ease-out

## Component mapping

| Existing surface | WAY B component | Action |
| --- | --- | --- |
| `.btn` variants | Button | restyle through tokens |
| `.inp` | TextField / TextArea | restyle through tokens |
| `.card`, `.card2` | Card | consolidate visual states |
| `.seg`, `.area-tabs` | Tabs / Chip | restyle active and inactive states |
| `.home-goal` | DailyFocusCard | restructure visually, keep event handler |
| `.daysummary` | ProgressSummary | restyle circular progress and metrics |
| `.t` task rows | HabitCard row | keep data and editing behavior |
| `.mentor-chat-entry`, `.mcard` | MentorCard | restyle |
| `.bubble`, `.chat-composer` | MessageBubble / ChatComposer | restyle |
| `.knowledge-item` | KnowledgeCard | restyle |
| `.way-profile-*` | ProfileHeader / SettingsItem | restyle |
| `.nav` | BottomNavigation | fixed five-item WAY navigation |
| `.toast` | Toast | restyle |

## Files

- `index.html`: variant metadata, WAY B stylesheet and small semantic labels
- `way-b.css`: tokens and complete visual system
- `manifest.json`: WAY B PWA identity and dark colors
- `sw.js`: isolated cache name and WAY B shell asset
- `WAY_B_IMPLEMENTATION.md`: audit and mapping

## Acceptance focus

- 320 px minimum viewport without horizontal overflow
- black `#0D0D0D` background, restrained `#C6FF00` accents
- Inter for interface, Montserrat only for WAY wordmark/splash
- fixed bottom navigation with safe-area support
- visible focus, pressed, disabled and selected states
- preserved role login, participant data, mentor flow, chat and Neon API
