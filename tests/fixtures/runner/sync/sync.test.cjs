// Stage 99 fixture (NOT a suite test). The synchronous path is unchanged.
test('sync pass', () => {
  assertEqual(1 + 1, 2);
});
test('sync fail', () => {
  throw new Error('deliberate sync failure');
});
