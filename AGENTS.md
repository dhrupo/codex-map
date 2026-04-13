# Repository Guidelines

## Project Structure & Module Organization
`server.js` is the Node/Express entrypoint and contains the API plus filesystem scan logic. `bin/cli.js` provides the `codex-map` CLI wrapper and handles flags like `--port`. Frontend assets live in `public/`: `index.html` boots the app, `app.js` contains the dashboard state/rendering logic, and `style.css` holds the visual system. Keep new static assets in `public/` and avoid adding extra top-level folders unless the app grows enough to justify them.

## Build, Test, and Development Commands
Use Node 18+ as declared in `package.json`.

- `npm install` installs runtime dependencies.
- `npm run dev` starts the server with `node --watch server.js` for local development.
- `npm start` runs the app without file watching.
- `node bin/cli.js --help` checks the CLI entrypoint and available flags.

Open `http://localhost:3131` by default, or pass `-p 8080` to test another port.

## Coding Style & Naming Conventions
Follow the existing JavaScript style: CommonJS modules, semicolons, single quotes, and 2-space indentation. Prefer small helper functions over deeply nested inline logic. Use `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for shared constants, and clear filenames like `public/app.js` rather than feature abbreviations. Keep frontend code framework-free unless the project direction changes.

## Testing Guidelines
There is no automated test suite yet. For every change, run `npm start` or `npm run dev` and verify the dashboard manually in a browser. Check both global and project views when touching scan logic, and verify CLI startup with `node bin/cli.js`. If you introduce automated tests later, place them next to the relevant module or in a small `test/` directory and keep names explicit, for example `server.scan.test.js`.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style such as `feat: add stats date range filters` and `fix: simplify project picker actions`. Keep commit messages imperative and scoped to one logical change. PRs should include a short summary, manual verification steps, linked issues when relevant, and screenshots or screen recordings for UI changes.

## Security & Configuration Tips
This app reads from `~/.codex` and project-local Codex files. Do not hardcode machine-specific paths, and be careful not to log or commit private local data captured during debugging.
