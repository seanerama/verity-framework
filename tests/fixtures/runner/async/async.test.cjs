// Stage 99 fixture (NOT a suite test — tests/fixtures/** is never discovered by
// the runner's non-recursive glob). An async body whose assertion throws after
// an await: the pre-stage-99 runner reported it as a pass.
test('async body asserts after an await', async () => {
  await null;
  assert(false, 'this assertion runs only after the runner has moved on');
});
