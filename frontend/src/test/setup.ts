import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installBrowserMocks, resetBrowserMocks } from './browserMocks';

installBrowserMocks({ eagerIntersection: true });

beforeEach(() => {
  resetBrowserMocks();
});

afterEach(() => {
  cleanup();
});
