# Contributing

## Development setup

1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and configure Azure access.
4. Run `npm run lint`, `npm run test`, and `npm run build` before opening a pull request.

## Testing requirements

- Keep all tests self-contained and mock every Azure SDK call.
- Maintain at least 80% coverage for lines, statements, branches, and functions.
- Add or update tests for each behavior change.

## Pull request guidelines

- Keep changes focused and documented.
- Include validation steps and representative CLI output when relevant.
- Prefer small, reviewable commits.
- Ensure CI is green before requesting review.
