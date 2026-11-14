# Frontend

Vite automatically loads `frontend/.env` and `frontend/.env.local` for development
and builds; `.env.local` overrides `.env`, and exported variables take precedence.
Mode-specific files such as `.env.production` follow Vite's standard loading rules.
Restart Vite after editing these files. Only `VITE_`-prefixed variables are exposed
to frontend code through `import.meta.env`; their values are public in the built
application. Keep database credentials and JWT secrets in backend environment
files. No frontend environment file is required for the current UI.

From the repository root, run `npm install`, then `npm run dev:frontend`.
Vite proxies `/api` to the Express API at `http://localhost:3000`, preserving
same-origin cookies and CSRF requests. Open the Vite URL using `localhost`;
for HTTP development, set `NODE_ENV=development` in `backend/.env.local` and
restart the API. For deployment, serve both services behind HTTPS and set
`NODE_ENV=production` so session cookies require HTTPS. Production hosting must route `/api` to Express and fall back to
`index.html` for frontend routes.

The frontend provides login/logout, own password changes, private template
listing and deletion, template creation/editing, administrator account
creation/disable, owner role controls, single-document generation, job history,
and retained PDF downloads.
Account creation is administrator-only; there is no public signup.

The frontend uses Tailwind CSS 4 through `@tailwindcss/vite` and daisyUI 5
for buttons, form controls, cards, and tables. `src/style.css` defines the
`automemorydoll` light theme, preserving the approved design's warm paper
surfaces and charcoal controls. Theme colors live in daisyUI's semantic color
variables; layouts and spacing use Tailwind utilities in the Vue templates.
The `workspace` (720px) and `cards` (1000px) breakpoints preserve existing
responsive layouts. No theme switcher or automatic dark theme is enabled.

The existing pages retain Noto Sans, compact top navigation, and responsive
template cards from `DESIGN.md` and `docs/design/approved-ui-mockup.html`.
Noto Sans loads from Google Fonts with a sans-serif fallback when unavailable.
The current templates API has no preview URLs or recent-use metadata, so cards
show “Preview unavailable” and preserve server ordering. Template creation
and editing include a file browser, text editor, and data-shape controls; the
file browser and editor use separate tabs on mobile. Selecting a template opens
its generation form: shaped values or a JSON object, plus required resource
uploads (20 MiB per file, 100 MiB total). Generation stays beside the PDF preview
and polls until success or failure. On mobile, success selects the Preview pane.
The PDF viewer has a single status bar at its top for Ready, Generating,
Generated, and Error, with contextual information and a right-aligned PDF
download. Job details use the same shared status bar above the PDF, with
confirmation and submission time in its information tooltip. The Generate action remains visible below the scrolling form.
Jobs and downloads remain available from Jobs after template deletion. PDF
preview uses the browser’s PDF viewer; downloading remains available if the
browser cannot embed PDFs.

Run `npm --workspace frontend test`, `npm --workspace frontend run typecheck`,
and `npm run build:frontend`. Tests mount the real views and router with a
stubbed HTTP boundary; they do not replace browser/API integration checks.

Workspace and generation JSON editing use the shared `CodeEditArea` component
with vue-codemirror and CodeMirror 6. Its `lang` prop accepts `latex`,
`jinja-latex`, or `javascript`; omitting it selects plain text. The root
`template.tex` uses the official Jinja parser with LaTeX as its base language.
Other TeX-related files use LaTeX, and JSON/JavaScript files use JavaScript
highlighting. JSON submission still requires a valid JSON object. Highlighting
is not compiler validation; no extra LaTeX linter or automatic TeX rewrite is
enabled. Save/dirty controls remain in `TextEditor`, and selecting a different
file starts a fresh editor history. Tab moves focus out of the editor.

While editing the root `template.tex`, Jinja autocomplete includes current
data-shape variable names with their display labels and types. Suggestions
update with shape edits, omit invalid draft names, and disappear when the shape
is disabled. Other files do not receive these suggestions. Authors can still
type ordinary Jinja built-ins and local variables; autocomplete does not validate
whether a variable will exist during compilation.
