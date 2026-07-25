// Redesign chip palette — soft tinted background + saturated foreground, all
// on the cool-neutral OKLCH scale from the AutoImport Redesign spec.
type Palette = { bg: string; fg: string };

const GREEN: Palette = { bg: 'oklch(0.93 0.05 150)', fg: 'oklch(0.4 0.11 150)' };
const AMBER: Palette = { bg: 'oklch(0.93 0.05 80)', fg: 'oklch(0.45 0.13 80)' };
const ORANGE: Palette = { bg: 'oklch(0.93 0.06 40)', fg: 'oklch(0.48 0.14 40)' };
const BLUE: Palette = { bg: 'oklch(0.93 0.03 250)', fg: 'oklch(0.45 0.13 250)' };
const PURPLE: Palette = { bg: 'oklch(0.93 0.04 300)', fg: 'oklch(0.45 0.12 300)' };
const GRAY: Palette = { bg: 'oklch(0.95 0.006 260)', fg: 'oklch(0.45 0.01 260)' };
const RED: Palette = { bg: 'oklch(0.93 0.06 25)', fg: 'oklch(0.5 0.15 25)' };

const PALETTES: Record<string, Palette> = {
  SOURCED: GRAY,
  PURCHASED: BLUE,
  IN_TRANSIT: AMBER,
  CUSTOMS: ORANGE,
  IN_STOCK: GREEN,
  RESERVED: PURPLE,
  SOLD: GREEN,
  DELIVERED: GRAY,
  DRAFT: GRAY,
  APPROVED: BLUE,
  SUBMITTED: AMBER,
  FAILED: RED,
  REJECTED: RED,
  CONFIRMED: GREEN,
  VALIDATED: BLUE,
  EXPIRED: GRAY,
  PENDING: GRAY,
  QUEUED: GRAY,
  PROCESSING: AMBER,
  PHASE0_COMPLETE: BLUE,
  PHASE1_COMPLETE: BLUE,
  COMPLETED: GREEN,
  UPLOADED: GRAY,
  ERROR: RED,
  CANCELLED: GRAY,
  SPLIT: PURPLE,
};

const LABELS: Record<string, string> = {
  SOURCED: 'Identificat',
  PURCHASED: 'Cumpărat',
  IN_TRANSIT: 'În tranzit',
  CUSTOMS: 'În vamă',
  IN_STOCK: 'În stoc',
  RESERVED: 'Rezervat',
  SOLD: 'Vândut',
  DELIVERED: 'Livrat',
  DRAFT: 'Ciornă',
  APPROVED: 'Aprobat',
  SUBMITTED: 'Trimis',
  FAILED: 'Eșuat',
  REJECTED: 'Respins',
  CONFIRMED: 'Confirmat',
  VALIDATED: 'Validat',
  EXPIRED: 'Expirat',
  PENDING: 'În așteptare',
  QUEUED: 'În coadă',
  PROCESSING: 'Se procesează',
  PHASE0_COMPLETE: 'Tip identificat',
  PHASE1_COMPLETE: 'Date extrase',
  COMPLETED: 'Procesat',
  UPLOADED: 'Încărcat',
  ERROR: 'Eroare',
  CANCELLED: 'Anulat',
  SPLIT: 'Împărțit',
};

export function StatusChip({ status }: { status: string }) {
  const p = PALETTES[status] ?? GRAY;
  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: p.bg, color: p.fg }}
    >
      {LABELS[status] ?? status}
    </span>
  );
}
