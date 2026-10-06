import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportPdfDialog, loadPdfOptions } from '../src/components/ExportPdfDialog';
import { DEFAULT_PDF_OPTIONS } from '../src/exportPdf';

afterEach(() => localStorage.clear());

describe('ExportPdfDialog', () => {
  it('exports with the chosen options and remembers them', () => {
    const onExport = vi.fn();
    render(<ExportPdfDialog title="Note" onExport={onExport} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: 'Letter' } });
    fireEvent.click(screen.getByLabelText('Landscape'));
    fireEvent.change(screen.getByLabelText('Margin'), { target: { value: 'minimal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export to PDF' }));
    const expected = { ...DEFAULT_PDF_OPTIONS, pageSize: 'Letter', landscape: true, margin: 'minimal' };
    expect(onExport).toHaveBeenCalledWith(expected);
    expect(loadPdfOptions()).toEqual(expected);
  });

  it('closes on Escape and on Cancel without exporting', () => {
    const onExport = vi.fn();
    const onClose = vi.fn();
    render(<ExportPdfDialog title="Note" onExport={onExport} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onExport).not.toHaveBeenCalled();
  });
});
