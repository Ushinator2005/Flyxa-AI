import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { formatCurrency } from '../../utils/calculations.js';
import './PayoutGallery.css';

const PAYOUT_GALLERY_KEY = 'flyxa_payout_gallery_photos_v1';

interface PayoutPhoto {
  id: string;
  src: string;
  name: string;
  createdAt: string;
}

function readPayoutPhotos(): PayoutPhoto[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PAYOUT_GALLERY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Partial<PayoutPhoto>;
        if (typeof record.id !== 'string' || typeof record.src !== 'string') return null;
        return {
          id: record.id,
          src: record.src,
          name: typeof record.name === 'string' ? record.name : 'Payout proof',
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        };
      })
      .filter((item): item is PayoutPhoto => item !== null);
  } catch {
    return [];
  }
}

export default function PayoutGallery({ total, payoutCount }: { total: number; payoutCount: number }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [photos, setPhotos] = useState<PayoutPhoto[]>(readPayoutPhotos);

  useEffect(() => {
    try {
      localStorage.setItem(PAYOUT_GALLERY_KEY, JSON.stringify(photos));
    } catch {
      // Keep the in-memory gallery usable if browser storage is full.
    }
  }, [photos]);

  const uploadPhotos = (files: FileList | null) => {
    if (!files?.length) return;
    Array.from(files)
      .filter(file => file.type.startsWith('image/'))
      .slice(0, 8)
      .forEach(file => {
        const reader = new FileReader();
        reader.onload = () => {
          const src = typeof reader.result === 'string' ? reader.result : '';
          if (!src) return;
          setPhotos(current => [{
            id: crypto.randomUUID(),
            src,
            name: file.name,
            createdAt: new Date().toISOString(),
          }, ...current].slice(0, 24));
        };
        reader.readAsDataURL(file);
      });
  };

  return (
    <section className="billing-payout-gallery">
      <header className="billing-payout-gallery-head">
        <div>
          <span className="billing-payout-gallery-label">Payout gallery</span>
          <h2>{formatCurrency(total)}</h2>
          <p>
            {photos.length} photo{photos.length === 1 ? '' : 's'} saved · {payoutCount} payout{payoutCount === 1 ? '' : 's'} recorded
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="billing-payout-gallery-input"
          onChange={event => {
            uploadPhotos(event.target.files);
            event.target.value = '';
          }}
        />
        <button type="button" className="billing-payout-gallery-upload" onClick={() => fileInputRef.current?.click()}>
          <Upload size={14} />
          Add payout proof
        </button>
      </header>

      {photos.length > 0 ? (
        <div className="billing-payout-gallery-grid">
          {photos.map(photo => (
            <figure key={photo.id} className="billing-payout-gallery-photo">
              <img src={photo.src} alt={photo.name} />
              <figcaption>
                <span>{new Date(photo.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <button
                  type="button"
                  aria-label="Delete payout photo"
                  onClick={() => setPhotos(current => current.filter(item => item.id !== photo.id))}
                >
                  <Trash2 size={12} />
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="billing-payout-gallery-empty">
          <Upload size={18} />
          <div>
            <strong>No payout proof uploaded</strong>
            <span>Add screenshots or photos to keep a visual record beside your payout ledger.</span>
          </div>
        </div>
      )}
    </section>
  );
}
