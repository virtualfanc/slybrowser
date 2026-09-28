# TypeScript examples

These examples use the published `slybrowser` package and its project WebDriver. They
never select a system browser or driver. Set `SLYBROWSER_AUTHORIZATION_FILE` to a local
authorization file before running them; keep that file and generated output private.

From `packages/node`, build the SDK and compile the examples with the installed
TypeScript compiler:

```sh
pnpm build
pnpm exec tsc -p examples/tsconfig.json
```

Run the emitted `.js` files under `.cache/examples`:

| Example | Purpose |
| --- | --- |
| [`collect-pages.ts`](collect-pages.ts) | Collect page title, description, heading, and link count as JSON lines. |
| [`capture-pages.ts`](capture-pages.ts) | Save screenshots with safe filenames in a local directory. |
| [`persistent-profile.ts`](persistent-profile.ts) | Reopen one local browser profile in two serial sessions. |
| [`form-draft.ts`](form-draft.ts) | Fill fields through native WebDriver typing without submitting the form. |

Use the scripts only on pages you are authorized to automate. The Free license allows
one active browser process, so the examples launch and close sessions sequentially.
