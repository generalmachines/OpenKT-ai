import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

// Registered by hand rather than via '@testing-library/jest-dom/vitest': in the
// npm workspace that entry can resolve a different hoisted copy of vitest.
expect.extend(matchers);

afterEach(() => cleanup());
