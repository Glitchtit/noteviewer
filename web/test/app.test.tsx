import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('App shell', () => {
  it('renders the shell', () => {
    render(<App />);
    expect(screen.getByText('noteviewer')).toBeTruthy();
  });
});
