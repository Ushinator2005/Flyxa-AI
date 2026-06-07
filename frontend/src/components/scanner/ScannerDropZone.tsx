import { useCallback, useRef, useState, type DragEvent } from 'react';
import { Camera, Image as ImageIcon, Menu, Upload } from 'lucide-react';

interface ScannerDropZoneProps {
  isScanning: boolean;
  scanError: string;
  scanPreviewUrl: string;
  onScanFile: (file: File) => void;
  onAddBlankDay: () => void;
  isMobile?: boolean;
  onOpenDayPanel?: () => void;
}

export default function ScannerDropZone({
  isScanning,
  scanError,
  scanPreviewUrl,
  onScanFile,
  onAddBlankDay,
  isMobile = false,
  onOpenDayPanel,
}: ScannerDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onScanFile(file);
    event.target.value = '';
  };

  if (isMobile) {
    return (
      <div data-tour-id="scanner-upload" className="tj-empty-entry">
        {/* hidden inputs */}
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFileChange} />

        <div className="tj-empty-wrap">
          <div className="tj-empty-card">
            {/* Day panel toggle */}
            {onOpenDayPanel && (
              <button
                type="button"
                className="tj-nav"
                onClick={onOpenDayPanel}
                style={{ alignSelf: 'flex-start', marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', fontSize: 12 }}
              >
                <Menu size={13} />
                View days
              </button>
            )}

            <span className="tj-empty-badge"><ImageIcon size={22} /></span>
            <p className="tj-empty-title">Add a Chart Screenshot</p>
            <p className="tj-empty-text">
              Flyxa reads your <span style={{ color: 'var(--amber)' }}>entry</span>,{' '}
              <span style={{ color: 'var(--amber)' }}>stop</span>,{' '}
              <span style={{ color: 'var(--amber)' }}>target</span>, and{' '}
              <span style={{ color: 'var(--amber)' }}>exit</span> automatically.
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

            <div className="tj-empty-actions" style={{ flexDirection: 'column', gap: 10, width: '100%' }}>
              <button
                type="button"
                className="tj-btn-primary"
                onClick={() => inputRef.current?.click()}
                disabled={isScanning}
                style={{ width: '100%', justifyContent: 'center', gap: 8 }}
              >
                <ImageIcon size={15} />
                Choose from Photos
              </button>
              <button
                type="button"
                className="tj-btn-primary"
                onClick={() => cameraInputRef.current?.click()}
                disabled={isScanning}
                style={{ width: '100%', justifyContent: 'center', gap: 8, background: 'var(--cobalt-dim)', border: '1px solid var(--cobalt-border)', color: 'var(--cobalt)' }}
              >
                <Camera size={15} />
                Open Camera
              </button>
              <button
                type="button"
                className="tj-btn-ghost"
                onClick={onAddBlankDay}
                disabled={isScanning}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                Start Blank Day
              </button>
            </div>
          </div>
          <div className="tj-empty-meta">PNG, JPG, WEBP · Max 10 MB</div>
        </div>
      </div>
    );
  }

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
        onChange={handleFileChange}
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
