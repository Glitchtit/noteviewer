import { createRef } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorPane, type EditorPaneHandle } from '../src/components/EditorPane';

describe('EditorPane', () => {
  it('mounts CodeMirror with the initial content', () => {
    const ref = createRef<EditorPaneHandle>();
    render(<EditorPane ref={ref} initialContent="# Hello" onChange={() => {}} onSave={() => {}} />);
    expect(ref.current?.view?.state.doc.toString()).toBe('# Hello');
  });

  it('reports document changes through onChange', () => {
    const ref = createRef<EditorPaneHandle>();
    const onChange = vi.fn();
    render(<EditorPane ref={ref} initialContent="a" onChange={onChange} onSave={() => {}} />);
    ref.current!.view!.dispatch({ changes: { from: 1, insert: 'bc' } });
    expect(onChange).toHaveBeenLastCalledWith('abc');
  });

  it('destroys the view on unmount', () => {
    const ref = createRef<EditorPaneHandle>();
    const { unmount } = render(
      <EditorPane ref={ref} initialContent="" onChange={() => {}} onSave={() => {}} />,
    );
    const handle = ref.current!; // React nulls ref.current on unmount — capture the handle first
    unmount();
    expect(handle.view).toBeNull();
  });
});
