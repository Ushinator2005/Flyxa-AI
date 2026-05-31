import { useCallback, useRef, useState, type DragEvent } from 'react';
import { Upload } from 'lucide-react';

interface ScannerDropZoneProps {
  isScanning: boolean;
  scanError: string;
  scanPreviewUrl: string;
  onScanFile: (file: File) => void;
  onAddBlankDay: () => void;
}

export default function ScannerDropZone({
  isScanning,
  scanError,
  scanPreviewUrl,
  onScanFile,
  onAddBlankDay,
}: ScannerDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onScanFile(file);
  }, [onScanFile]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setIsDragging(false);
  }, []);

  return (
    <div
      data-tour-id="scanner-upload"
      className="tj-empty-entry"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) onScanFile(file);
          event.target.value = '';
        }}
      />
      <div className="tj-empty-wrap">
        <div className={`tj-empty-card ${isDragging ? 'drag' : ''}`}>
          <span className="tj-empty-badge"><Upload size={20} /></span>
          <p className="tj-empty-title">Drop a Chart Screenshot</p>
          <p className="tj-empty-text">
            Flyxa reads your <span style={{ color: 'var(--amber)' }}>entry</span>,{' '}
            <span style={{ color: 'var(--amber)' }}>stop loss</span>,{' '}
            <span style={{ color: 'var(--amber)' }}>take profit</span>, and{' '}
            <span style={{ color: 'var(--amber)' }}>exit</span>
            <br />
            automatically in seconds.
          </p>
          {scanError && <p className="tj-empty-text tj-empty-error">{scanError}</p>}
          {isScanning && (
            <div className="tj-scan-stage" role="status" aria-live="polite">
              {scanPreviewUrl && (
                <div className="tj-scan-preview">
                  <img src={scanPreviewUrl} alt="Chart being scanned" />
                  <div className="tj-scan-overlay">
                    <span className="tj-scan-overlay-label">Scanning</span>
                  </div>
                </div>
              )}
              <div className="tj-scan-status">
                <span className="tj-scan-dot" />
                <span className="tj-scan-dot" />
                <span className="tj-scan-dot" />
              </div>
              <p className="tj-empty-text">Patience is expensive, but revenge is costlier.</p>
            </div>
          )}
          <div className="tj-empty-actions">
            <button
              type="button"
              className="tj-btn-primary"
              onClick={() => inputRef.current?.click()}
              disabled={isScanning}
            >
              Upload File
            </button>
            <button
              type="button"
              className="tj-btn-ghost"
              onClick={onAddBlankDay}
              disabled={isScanning}
            >
              Start Blank Day
            </button>
          </div>
        </div>
        <div className="tj-empty-meta">PNG, JPG, or WEBP · Max 10 MB</div>
      </div>
    </div>
  );
}
