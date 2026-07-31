export const VEHICLE_STATUSES = [
  {
    value: 'SOURCED',
    label: 'Identificat',
    description: 'Vehicul găsit, încă nu a fost cumpărat',
    dotClass: 'bg-slate-400',
  },
  {
    value: 'PURCHASED',
    label: 'Cumpărat',
    description: 'Achiziția a fost finalizată',
    dotClass: 'bg-blue-500',
  },
  {
    value: 'IN_TRANSIT',
    label: 'În tranzit',
    description: 'Vehiculul este în drum spre România',
    dotClass: 'bg-amber-500',
  },
  {
    value: 'CUSTOMS',
    label: 'În vamă',
    description: 'Formalitățile vamale sunt în curs',
    dotClass: 'bg-orange-500',
  },
  {
    value: 'IN_STOCK',
    label: 'În stoc',
    description: 'Vehiculul este disponibil în parc',
    dotClass: 'bg-emerald-500',
  },
  {
    value: 'RESERVED',
    label: 'Rezervat',
    description: 'Vehiculul este rezervat unui client',
    dotClass: 'bg-violet-500',
  },
  {
    value: 'SOLD',
    label: 'Vândut',
    description: 'Vânzarea a fost încheiată',
    dotClass: 'bg-green-600',
  },
  {
    value: 'DELIVERED',
    label: 'Livrat',
    description: 'Vehiculul a fost predat clientului',
    dotClass: 'bg-slate-500',
  },
] as const;

export type VehicleStatus = (typeof VEHICLE_STATUSES)[number]['value'];

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, string> =
  Object.fromEntries(
    VEHICLE_STATUSES.map(({ value, label }) => [value, label]),
  ) as Record<VehicleStatus, string>;

export function getVehicleStatus(status: string) {
  return VEHICLE_STATUSES.find((item) => item.value === status);
}
