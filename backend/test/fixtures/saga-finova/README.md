# Finova SAGA golden fixture

The six XML files in `golden/` are generated from one shared deterministic
fixture using a small reference port of Finova's SAGA formatters.

Reference repository:

- workspace: `/Users/test/conductor/workspaces/Finova/el-paso`
- commit: `ed54686382e94d1ed86718a90f6289bab2f05e62`
- source: `client/src/app/Pages/ExportsPage.tsx`

`saga-golden.spec.ts` checks two independent paths against the committed files:

1. the frozen Finova reference formatter;
2. AutoImport's production formatter.

Update the files with `UPDATE_SAGA_GOLDEN=1 npm run test:saga-golden` only after
reviewing and recording an intentional change in the Finova formatter.
