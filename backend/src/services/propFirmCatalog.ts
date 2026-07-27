import catalogJson from '../data/prop-firm-catalog.json';

export interface CatalogFirm {
  firm: string;
  website: string;
  scrapedAt: string;
  programs: unknown[];
  generalNotes?: string;
  payoutPolicy?: string;
}

export interface PropFirmCatalog {
  generatedAt: string;
  note: string;
  firms: CatalogFirm[];
}

const catalog = catalogJson as unknown as PropFirmCatalog;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function getPropFirmCatalog(firm?: string): PropFirmCatalog {
  if (!firm) return catalog;
  const wanted = slug(firm);
  return {
    ...catalog,
    firms: catalog.firms.filter(entry => slug(entry.firm) === wanted || slug(entry.firm).includes(wanted)),
  };
}
