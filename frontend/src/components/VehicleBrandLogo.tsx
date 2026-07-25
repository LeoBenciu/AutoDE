import type { SimpleIcon } from 'simple-icons';
import {
  siAstonmartin,
  siAudi,
  siBentley,
  siBmw,
  siChevrolet,
  siCitroen,
  siDacia,
  siFiat,
  siFord,
  siHonda,
  siHyundai,
  siJeep,
  siKia,
  siMazda,
  siMini,
  siMitsubishi,
  siNissan,
  siOpel,
  siPeugeot,
  siPorsche,
  siRenault,
  siSeat,
  siSkoda,
  siSubaru,
  siSuzuki,
  siTesla,
  siToyota,
  siVolkswagen,
  siVolvo,
} from 'simple-icons';
import { normalizeBrand } from '../data/vehicleCatalog';

const BRAND_ICONS: Record<string, SimpleIcon> = {
  astonmartin: siAstonmartin,
  audi: siAudi,
  bentley: siBentley,
  bmw: siBmw,
  chevrolet: siChevrolet,
  citroen: siCitroen,
  dacia: siDacia,
  fiat: siFiat,
  ford: siFord,
  honda: siHonda,
  hyundai: siHyundai,
  jeep: siJeep,
  kia: siKia,
  mazda: siMazda,
  mini: siMini,
  mitsubishi: siMitsubishi,
  nissan: siNissan,
  opel: siOpel,
  peugeot: siPeugeot,
  porsche: siPorsche,
  renault: siRenault,
  seat: siSeat,
  skoda: siSkoda,
  subaru: siSubaru,
  suzuki: siSuzuki,
  tesla: siTesla,
  toyota: siToyota,
  volkswagen: siVolkswagen,
  volvo: siVolvo,
};

const DARK_LOGOS = new Set(['opel', 'renault']);

export function VehicleBrandLogo({
  make,
  size = 'md',
}: {
  make: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const key = normalizeBrand(make);
  const icon = BRAND_ICONS[key];
  const dimensions = {
    sm: 'h-7 w-7 rounded-lg p-1.5',
    md: 'h-10 w-10 rounded-xl p-2',
    lg: 'h-12 w-12 rounded-xl p-2.5',
  }[size];

  return (
    <span
      role="img"
      aria-label={`Sigla ${make || 'mărcii'}`}
      title={make || 'Marcă'}
      data-brand-logo={key}
      className={`inline-flex shrink-0 items-center justify-center border border-line bg-white shadow-[0_1px_2px_rgba(20,20,40,0.05)] ${dimensions}`}
    >
      {key === 'mercedesbenz' ? (
        <MercedesLogo />
      ) : key === 'landrover' ? (
        <LandRoverLogo />
      ) : icon ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-full w-full">
          <path d={icon.path} fill={DARK_LOGOS.has(key) ? '#252833' : `#${icon.hex}`} />
        </svg>
      ) : (
        <span className="text-[10px] font-extrabold tracking-tight text-ink-soft">
          {brandInitials(make)}
        </span>
      )}
    </span>
  );
}

function MercedesLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-full w-full text-slate-700">
      <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3.2v8.35M12 11.55l-7.25 4.18M12 11.55l7.25 4.18" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function LandRoverLogo() {
  return (
    <svg viewBox="0 0 32 20" aria-hidden="true" className="h-full w-full">
      <ellipse cx="16" cy="10" rx="14" ry="7.5" fill="#005A2B" />
      <text x="16" y="12" textAnchor="middle" fill="white" fontFamily="Arial, sans-serif" fontSize="5.2" fontWeight="700">
        LAND ROVER
      </text>
    </svg>
  );
}

function brandInitials(make: string): string {
  const parts = make.trim().split(/[\s-]+/).filter(Boolean);
  return (parts.length > 1 ? parts.map((part) => part[0]).join('') : make.slice(0, 2)).toUpperCase();
}
