import { expect, test } from 'vitest';
import { PROJECT_NAME } from './placeholder.ts';

test('the test runner works with the project toolchain', () => {
  expect(PROJECT_NAME).toBe('late-payment-assistant');
});
