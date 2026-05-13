import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installBrowserMocks, resetBrowserMocks } from './browserMocks';

if (typeof window !== 'undefined') {
  installBrowserMocks({ immediateIntersectionCallbacks: true });
}

beforeEach(() => {
  if (typeof window !== 'undefined') {
    resetBrowserMocks();
  }
});

afterEach(() => {
  cleanup();
});
