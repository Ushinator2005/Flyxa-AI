import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { formatCurrency } from '../../utils/calculations.js';
import { uploadScreenshot } from '../../utils/uploadScreenshot.js';
import { supabase } from '../../services/api.js';
import useFlyxaStore from '../../store/flyxaStore.js';
import type { PayoutProof } from '../../store/types.js';
import './PayoutGallery.css';

// Old device-only gallery key; read once to migrate into the cloud store.
const LEGACY_KEY = 'flyxa_payout_gallery_photos_v1';

export default function PayoutGallery({ total, payoutCount }: { total: number; payoutCount: number }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photos = useFlyxaStore(state => state.payoutGallery);
  const addPayoutProof = useFlyxaStore(state => state.addPayoutProof);
  const deletePayoutProof = useFlyxaStore(state => state.deletePayoutProof);
  const [uploading, setUploading] = useState(false);

  // One-time migration: move any photos left in the old localStorage gallery
  // into the cloud store so nothing already saved is lost, then drop the key.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PayoutProof>[];
      if (Array.isArray(parsed) && parsed.length > 0 && useFlyxaStore.getState().payoutGallery.length === 0) {
        parsed
          .filter(p => p && typeof p.id === 'string' && typeof p.src === 'string')
          .forEach(p => addPayoutProof({
            id: p.id as string,
            src: p.src as string,
            name: typeof p.name === 'string' ? p.name : 'Payout proof',
            createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
          }));
      }
    } catch {
      // Ignore malformed legacy data.
    }
    localStorage.removeItem(LEGACY_KEY);
  }, [addPayoutProof]);

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/')).slice(0, 8);
    if (!imageFiles.length) return;

    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;
      for (const file of imageFiles) {
        const dataUrl = await new Promise<string>(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
          reader.onerror = () => resolve('');
          reader.readAsDataURL(file);
        });
        if (!dataUrl) continue;
        // Upload to Supabase Storage so the proof persists in the cloud (and syncs
        // across devices); uploadScreenshot falls back to the data URL if the
        // bucket is unavailable so the image still shows on this device.
        const src = userId ? await uploadScreenshot(dataUrl, userId) : dataUrl;
        addPayoutProof({ id: crypto.randomUUID(), src, name: file.name, createdAt: new Date().toISOString() });
      }
    } finally {
      setUploading(false);
    }
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
            void uploadPhotos(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="billing-payout-gallery-upload"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={uploading ? { opacity: 0.6, cursor: 'wait' } : undefined}
        >
          <Upload size={14} />
          {uploading ? 'Saving…' : 'Add payout proof'}
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
                  onClick={() => deletePayoutProof(photo.id)}
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
