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

Task 7 provides login/logout, own password changes, private template listing
and deletion, administrator account creation/disable, and owner role controls.
Template creation/editing and document generation screens are later tasks.
Account creation is administrator-only; there is no public signup.

The existing pages follow the approved design in `DESIGN.md` and
`docs/design/approved-ui-mockup.html`: Noto Sans, warm paper surfaces,
charcoal controls, compact top navigation, and responsive template cards.
Noto Sans loads from Google Fonts with a sans-serif fallback when unavailable.
The account trigger uses the locally served Font Awesome Free 6.7.2 regular user
SVG at `public/images/user-regular.svg`, from the official
[Font Awesome repository](https://github.com/FortAwesome/Font-Awesome/blob/6.7.2/svgs/regular/user.svg).
Its embedded attribution and CC BY 4.0 license notice are preserved.
The current templates API has no preview URLs or recent-use metadata, so cards
show “Preview unavailable” and preserve server ordering. Generation and editing
workspaces, including their mobile tabs, remain later tasks.

Run `npm --workspace frontend test`, `npm --workspace frontend run typecheck`,
and `npm run build:frontend`. Tests mount the real views and router with a
stubbed HTTP boundary; they do not replace browser/API integration checks.
