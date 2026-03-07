# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the backend TypeScript application.
- `src/index.ts` is the runtime entrypoint (Express server + service bootstrap).
- Feature modules are grouped by domain: `gateway/`, `whatsapp/`, `ocr/`, `records/`, `infrastructure/`, `shared/`, and `config/`.
- `database/migrations/` stores SQL schema changes (`001_initial_schema.sql`, `002_aquabot_additions.sql`).
- `baileys-auth/` holds local auth/session artifacts for the Baileys provider.
- `aquabot-ui/` currently contains UI-oriented source placeholders and notes.

## Build, Test, and Development Commands
Run all commands from repository root:
- `npm install` installs dependencies.
- `npm run dev` starts the app with `tsx` watch mode for local development.
- `npm run build` compiles TypeScript into `dist/`.
- `npm start` runs the compiled app from `dist/index.js`.
- `npm run typecheck` performs strict type checking with no emit.

## Coding Style & Naming Conventions
- Language: TypeScript (`strict` mode enabled in `tsconfig.json`).
- Indentation: 2 spaces; keep lines readable and avoid overly dense logic blocks.
- File names use `kebab-case` with role suffixes where useful (for example, `message-gateway.service.ts`, `redis.client.ts`).
- Classes/Types use `PascalCase`; functions/variables use `camelCase`; constants use `UPPER_SNAKE_CASE` for env keys.
- Prefer small, composable services and explicit imports from module `index.ts` exports.

## Testing Guidelines
- There is no dedicated test runner configured yet.
- Minimum validation before opening a PR: `npm run typecheck`, `npm run build`, and a local `/health` smoke check.
- New tests should be added alongside source or in a dedicated `tests/` folder using `*.test.ts` naming.

## Commit & Pull Request Guidelines
- Current Git history is minimal (`initial commit`), so follow clear, imperative commit subjects.
- Recommended commit style: Conventional Commits (for example, `feat(ocr): add field normalization`).
- Keep commits scoped to one logical change.
- PRs should include: purpose summary, key implementation notes, setup/migration steps (if any), and sample request/response logs or screenshots for behavioral changes.

## Security & Configuration Tips
- Copy `.env.example` to `.env` and never commit secrets.
- Required integrations include Anthropic, Supabase, and Redis; validate env values through `src/config/index.ts` schema before running in production.
