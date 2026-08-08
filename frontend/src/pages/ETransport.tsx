import { FormEvent, useRef, useState } from 'react';
import {
  useCreateEtransportMutation,
  useEtransportQuery,
  useLazyBnrRateQuery,
  useLazyCompanyFromAnafQuery,
  useLazyEtransportPrefillQuery,
  useParseEtransportMessageMutation,
  useSubmitEtransportMutation,
  useUpdateEtransportMutation,
  useVehiclesQuery,
} from '../store/api';
import { apiUrl } from '../store/apiBase';
import { StatusChip } from '../components/StatusChip';

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const TruckIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 17h9V7H3zM12 10h4l3 3v4h-7z" />
    <circle cx="7" cy="19" r="1.6" />
    <circle cx="17" cy="19" r="1.6" />
  </svg>
);

const OPERATION_TYPES = [
  ['AIC', 'Achiziție intracomunitară'],
  ['IMP', 'Import'],
  ['LIC', 'Livrare intracomunitară'],
  ['EXP', 'Export'],
  ['TTN', 'Transport național'],
  ['LHI', 'Lohn intrare'],
  ['LHE', 'Lohn ieșire'],
  ['SCI', 'Stoc client intrare'],
  ['SCE', 'Stoc client ieșire'],
  ['DIN', 'Depozitare intrare'],
  ['DIE', 'Depozitare ieșire'],
] as const;

// Every transport in this app is a passenger car (NC heading 8703), so the
// NC/tariff field defaults to 87035000 — the user can still override it.
const DEFAULT_TARIFF_CODE = '87035000';

function TruckTile() {
  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
      style={{ backgroundColor: 'oklch(0.95 0.006 260)', color: 'oklch(0.45 0.01 260)' }}
    >
      <TruckIcon size={15} />
    </div>
  );
}

export default function ETransport() {
  const { data: declarations = [] } = useEtransportQuery();
  const [submitDecl] = useSubmitEtransportMutation();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState('');

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-ink">e-Transport</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover"
        >
          <PlusIcon />
          Generează cod UIT
        </button>
      </div>
      <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-muted">
        Transportul internațional al mașinilor spre România se declară la ANAF <b className="text-ink-soft">înainte</b> de plecare —
        lipsa codului UIT la control înseamnă <b className="text-red-600">amendă și confiscarea contravalorii mărfii</b>.
        Șoferul trebuie să aibă codul UIT asupra lui.
      </p>
      {error && <p className="mt-3 rounded-control bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-5 space-y-2">
        {declarations.map((d: any) => {
          // Loss framing: an expiring UIT is an actionable risk, show the countdown.
          const daysLeft =
            d.status === 'CONFIRMED' && d.validUntil
              ? Math.ceil((new Date(d.validUntil).getTime() - Date.now()) / (24 * 3600 * 1000))
              : null;
          return (
          <div key={d.id} className="rounded-card border border-line bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-3">
                <TruckTile />
                <div>
                  <p className={`text-[14.5px] font-semibold text-ink ${d.uit ? 'font-mono' : ''}`}>
                    {d.uit ? d.uit : `Declarație #${d.id}`}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-muted">
                    {d.vehicle ? `${d.vehicle.make} ${d.vehicle.model} · ` : ''}
                    {d.vehiclePlate ?? 'fără nr. camion'} · {d.operationType}
                    {daysLeft != null && daysLeft >= 0 && (
                      <span className={daysLeft <= 2 ? 'ml-1 font-semibold text-red-600' : 'ml-1 text-muted'}>
                        · UIT expiră în {daysLeft === 0 ? 'sub 24h' : `${daysLeft} zile`}
                      </span>
                    )}
                    {daysLeft != null && daysLeft < 0 && (
                      <span className="ml-1 font-semibold text-red-600">· UIT expirat</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusChip status={d.status} />
                {d.status !== 'SUBMITTED' && (
                  <button
                    onClick={() => setEditing(d)}
                    className="rounded-lg border border-line-strong bg-white px-3.5 py-2 text-[13px] text-ink-soft"
                    title="Modificarea regenerează codul UIT"
                  >
                    Modifică
                  </button>
                )}
                {(d.status === 'DRAFT' || d.status === 'REJECTED') && (
                  <button
                    onClick={async () => {
                      setError('');
                      try {
                        await submitDecl(d.id).unwrap();
                      } catch (err: any) {
                        setError(err?.data?.message ?? 'Eroare la trimitere');
                      }
                    }}
                    className="rounded-lg bg-sidebar px-3.5 py-2 text-[13px] font-semibold text-white"
                  >
                    Trimite la ANAF
                  </button>
                )}
                {d.uit && (
                  <a
                    href={apiUrl(`/etransport/${d.id}/uit-sheet`)}
                    className="rounded-lg border border-line-strong bg-white px-3.5 py-2 text-[13px] text-ink-soft"
                  >
                    Fișă UIT
                  </a>
                )}
              </div>
            </div>
          </div>
          );
        })}
        {declarations.length === 0 && (
          <div className="rounded-card border-[1.5px] border-dashed border-line-strong bg-white p-12 text-center">
            <div className="mx-auto mb-3.5 flex h-11 w-11 items-center justify-center rounded-[11px] bg-canvas text-muted">
              <TruckIcon />
            </div>
            <p className="text-[15px] font-semibold text-ink-soft">Nicio declarație încă</p>
            <p className="mx-auto mt-1.5 mb-4 max-w-xs text-[13.5px] text-muted">
              Generează un cod UIT înainte de plecarea transportului.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="rounded-control bg-brand px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-hover"
            >
              + Generează cod UIT
            </button>
          </div>
        )}
      </div>

      {showForm && <NewDeclarationModal onClose={() => setShowForm(false)} />}
      {editing && <NewDeclarationModal declaration={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function NewDeclarationModal({ declaration, onClose }: { declaration?: any; onClose: () => void }) {
  const { data: vehicles = [] } = useVehiclesQuery();
  const [prefill] = useLazyEtransportPrefillQuery();
  const [fetchBnrRate, { isFetching: fetchingRate }] = useLazyBnrRateQuery();
  const [create, { isLoading: creating }] = useCreateEtransportMutation();
  const [update, { isLoading: updating }] = useUpdateEtransportMutation();
  const [parseMessage, { isLoading: parsingMessage }] = useParseEtransportMessageMutation();
  const [lookupTransporter, { isFetching: loadingTransporterName }] = useLazyCompanyFromAnafQuery();
  const isLoading = creating || updating;
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [driveInfo, setDriveInfo] = useState<any | null>(null);
  const prefillRequest = useRef(0);
  const [transportMessage, setTransportMessage] = useState('');
  const [messageResult, setMessageResult] = useState('');
  const [form, setForm] = useState(() =>
    declaration
      ? {
          vehicleId: declaration.vehicleId ? String(declaration.vehicleId) : '',
          operationType: declaration.operationType ?? '',
          transportDate: declaration.transportDate ? String(declaration.transportDate).slice(0, 10) : '',
          transporterName: declaration.transporter?.name ?? '',
          transporterTaxId: declaration.transporter?.taxId ?? '',
          transporterCountry: declaration.transporter?.country ?? 'DE',
          vehiclePlate: declaration.vehiclePlate ?? '',
          trailerPlate: declaration.trailerPlate ?? '',
          loadingCity: declaration.loadingPlace?.city ?? '',
          loadingCountry: declaration.loadingPlace?.country ?? 'DE',
          unloadingCity: declaration.unloadingPlace?.city ?? '',
          unloadingCounty: declaration.unloadingPlace?.county ?? '',
          unloadingAddress: declaration.unloadingPlace?.address ?? '',
          goodsDescription: declaration.goods?.[0]?.description ?? '',
          tariffCode: declaration.goods?.[0]?.tariffCode || DEFAULT_TARIFF_CODE,
          weightKg: declaration.goods?.[0]?.weightKg != null ? String(declaration.goods[0].weightKg) : '',
          valueWithoutVat:
            declaration.goods?.[0]?.valueWithoutVat != null
              ? String(declaration.goods[0].valueWithoutVat)
              : declaration.goods?.[0]?.valueRon != null
                ? String(declaration.goods[0].valueRon)
                : '',
          currency: declaration.goods?.[0]?.currency ?? 'RON',
          valueRon: declaration.goods?.[0]?.valueRon != null ? String(declaration.goods[0].valueRon) : '',
          exchangeRate: declaration.goods?.[0]?.exchangeRate != null ? String(declaration.goods[0].exchangeRate) : '',
          exchangeRateDate: declaration.goods?.[0]?.exchangeRateDate ?? '',
          dataVerified: false,
        }
      : {
          vehicleId: '',
          operationType: '',
          transportDate: '',
          transporterName: '',
          transporterTaxId: '',
          transporterCountry: 'DE',
          vehiclePlate: '',
          trailerPlate: '',
          loadingCity: '',
          loadingCountry: 'DE',
          unloadingCity: '',
          unloadingCounty: '',
          unloadingAddress: '',
          goodsDescription: '',
          tariffCode: DEFAULT_TARIFF_CODE,
          weightKg: '',
          valueWithoutVat: '',
          currency: 'EUR',
          valueRon: '',
          exchangeRate: '',
          exchangeRateDate: '',
          dataVerified: false,
        },
  );

  const onVehicleChange = async (vehicleId: string) => {
    const requestId = ++prefillRequest.current;
    setForm((f) => ({ ...f, vehicleId }));
    setError('');
    setDriveInfo(null);
    if (!vehicleId) {
      setWarnings([]);
      return;
    }
    // Pre-fill the purchase data already extracted from the invoice/contract.
    try {
      const p = await prefill(Number(vehicleId)).unwrap();
      if (requestId !== prefillRequest.current) return;
      setWarnings(p.warnings ?? []);
      setDriveInfo({
        ...p.drive,
        weightKg: p.goods?.[0]?.weightKg ?? null,
        unloadingCity: p.unloadingPlace?.city ?? null,
      });
      setForm((f) => ({
        ...f,
        vehicleId,
        operationType: p.operationType ?? '',
        transportDate: p.transportDate ?? '',
        transporterName: p.transporter?.name ?? f.transporterName,
        transporterTaxId: p.transporter?.taxId ?? f.transporterTaxId,
        transporterCountry: p.transporter?.country ?? f.transporterCountry,
        vehiclePlate: p.vehiclePlate ?? f.vehiclePlate,
        trailerPlate: p.trailerPlate ?? f.trailerPlate,
        loadingCity: p.loadingPlace?.city ?? f.loadingCity,
        loadingCountry: p.loadingPlace?.country ?? f.loadingCountry,
        unloadingCity: p.unloadingPlace?.city ?? f.unloadingCity,
        unloadingCounty: p.unloadingPlace?.county || f.unloadingCounty,
        unloadingAddress: p.unloadingPlace?.address || f.unloadingAddress,
        goodsDescription: p.goods?.[0]?.description ?? f.goodsDescription,
        tariffCode: p.goods?.[0]?.tariffCode || DEFAULT_TARIFF_CODE,
        weightKg: p.goods?.[0]?.weightKg != null ? String(p.goods[0].weightKg) : '',
        valueWithoutVat: p.goods?.[0]?.valueWithoutVat != null ? String(p.goods[0].valueWithoutVat) : '',
        currency: p.goods?.[0]?.currency ?? f.currency,
        valueRon: p.goods?.[0]?.valueRon != null ? String(p.goods[0].valueRon) : f.valueRon,
        exchangeRate: p.goods?.[0]?.exchangeRate != null ? String(p.goods[0].exchangeRate) : '',
        exchangeRateDate: p.goods?.[0]?.exchangeRateDate ?? '',
        dataVerified: false,
      }));
    } catch (err: any) {
      if (requestId !== prefillRequest.current) return;
      setError(err?.data?.message ?? 'Datele vehiculului nu au putut fi precompletate');
    }
  };

  const fillFromTransportMessage = async () => {
    setError('');
    setMessageResult('');
    try {
      const result = await parseMessage(transportMessage).unwrap();
      const parsed = result?.fields ?? {};
      const messageCui = String(parsed.transporter_tax_id ?? '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/^RO/i, '');
      // When the message carries a Romanian CUI, take the transporter name from
      // ANAF (fetched below) instead of the message text; keep the message name
      // only as a fallback for foreign transporters ANAF can't resolve.
      const nameFromAnaf = /^\d{2,10}$/.test(messageCui);
      const values: Record<string, unknown> = {
        transporterName: nameFromAnaf ? undefined : parsed.transporter_name,
        transporterTaxId: parsed.transporter_tax_id,
        transporterCountry: parsed.transporter_country,
        vehiclePlate: parsed.vehicle_plate,
        trailerPlate: parsed.trailer_plate,
        loadingCity: parsed.loading_city,
        loadingCountry: parsed.loading_country,
        // LOCATIE from the VIN table is authoritative when a row was found.
        unloadingCity: driveInfo?.matched ? undefined : parsed.unloading_city,
        unloadingCounty: parsed.unloading_county,
        transportDate: parsed.transport_date,
      };
      setForm((current) => {
        const next = { ...current, dataVerified: false };
        Object.entries(values).forEach(([fieldName, value]) => {
          if (value != null && String(value).trim() !== '') {
            (next as any)[fieldName] = String(value).trim();
          }
        });
        return next;
      });
      // Fetch the official name from ANAF using the CUI from the message.
      if (nameFromAnaf) void lookupTransporterName(messageCui);
      const labels: Record<string, string> = {
        transporter_name: 'transportator',
        transporter_tax_id: 'cod fiscal',
        transporter_country: 'țară transportator',
        vehicle_plate: 'număr camion',
        trailer_plate: 'număr remorcă',
        loading_city: 'oraș încărcare',
        loading_country: 'țară încărcare',
        unloading_city: 'oraș descărcare',
        unloading_county: 'județ descărcare',
        transport_date: 'data transportului',
      };
      const filled = (result?.foundFields ?? [])
        .map((fieldName: string) => labels[fieldName] ?? fieldName)
        .join(', ');
      setMessageResult(`Completat din mesaj: ${filled}. Verifică valorile înainte de salvare.`);
      setWarnings((current) =>
        current.filter((warning) => !warning.startsWith('Lipește mesajul transportatorului')),
      );
    } catch (err: any) {
      setError(err?.data?.message ?? 'Mesajul transportatorului nu a putut fi analizat');
    }
  };

  // Fill the transporter name from ANAF using its CUI. Called on blur of "Cod
  // fiscal transportator" (no argument → reads the field) and from the message
  // parser (passes the CUI it just extracted, since state hasn't flushed yet).
  // A foreign VAT (DE…, HU…) has no ANAF record so it's skipped, and any lookup
  // failure is silent — the name stays editable for manual entry.
  const lookupTransporterName = async (rawTaxId?: string) => {
    const cui = String(rawTaxId ?? form.transporterTaxId ?? '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/^RO/i, '');
    if (!/^\d{2,10}$/.test(cui)) return;
    const requestId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());
    try {
      const details = await lookupTransporter({ cui, requestId }).unwrap();
      if (!details?.name) return;
      setForm((f) => {
        // Apply only if the field still holds this CUI (guards against a stale
        // response after the user/message changed the tax id).
        const currentCui = String(f.transporterTaxId ?? '')
          .trim()
          .replace(/\s+/g, '')
          .replace(/^RO/i, '');
        return currentCui === cui ? { ...f, transporterName: details.name } : f;
      });
    } catch {
      // Non-fatal: ANAF has nothing for this CUI or is unavailable.
    }
  };

  // Pull the official BNR rate (cursbnr.ro) for the selected currency and
  // transport date, filling the exchange rate so the declared RON value is the
  // legal conversion. Clears any manual RON override so it recomputes.
  const applyBnrRate = async () => {
    if (!form.currency || form.currency === 'RON') return;
    setError('');
    try {
      const result = await fetchBnrRate({
        currency: form.currency,
        date: form.transportDate || undefined,
      }).unwrap();
      setForm((f) => ({
        ...f,
        exchangeRate: String(result.rate),
        exchangeRateDate: result.rateDate,
        valueRon: '',
      }));
    } catch (err: any) {
      setError(err?.data?.message ?? 'Cursul BNR nu a putut fi obținut');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = {
      vehicleId: form.vehicleId ? Number(form.vehicleId) : undefined,
      operationType: form.operationType,
      transportDate: form.transportDate,
      dataVerified: form.dataVerified,
      transporter: { name: form.transporterName, taxId: form.transporterTaxId, country: form.transporterCountry },
      vehiclePlate: form.vehiclePlate,
      trailerPlate: form.trailerPlate || undefined,
      loadingPlace: { country: form.loadingCountry, city: form.loadingCity },
      unloadingPlace: { country: 'RO', county: form.unloadingCounty, city: form.unloadingCity, address: form.unloadingAddress },
      goods: [
        {
          description: form.goodsDescription,
          tariffCode: form.tariffCode,
          weightKg: form.weightKg ? Number(form.weightKg) : undefined,
          valueWithoutVat: form.valueWithoutVat ? Number(form.valueWithoutVat) : undefined,
          currency: form.currency,
          valueRon: form.valueRon ? Number(form.valueRon) : undefined,
          exchangeRate: form.exchangeRate ? Number(form.exchangeRate) : undefined,
          exchangeRateDate: form.exchangeRateDate || undefined,
        },
      ],
    };
    try {
      if (declaration) await update({ id: declaration.id, body }).unwrap();
      else await create(body).unwrap();
      onClose();
    } catch (err: any) {
      setError(err?.data?.message ?? 'Eroare la salvare');
    }
  };

  const field = 'w-full box-border rounded-control border border-line-strong px-3 py-2.5 text-sm focus:border-brand focus:outline-none';
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const currentRonValue = form.valueWithoutVat
    ? form.currency === 'RON'
      ? Number(form.valueWithoutVat)
      : form.exchangeRate
        ? Number(form.valueWithoutVat) * Number(form.exchangeRate)
        : form.valueRon
          ? Number(form.valueRon)
          : null
    : null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center overflow-y-auto bg-[rgba(15,15,25,0.5)] sm:items-center sm:p-5" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-6 shadow-[0_20px_60px_-15px_rgba(20,20,40,0.4)] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-bold text-ink">
            {declaration ? `Modifică declarația #${declaration.id}` : 'Declarație e-Transport nouă'}
          </h2>
          <button onClick={onClose} className="p-1 text-lg leading-none text-muted hover:text-ink">✕</button>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {declaration
            ? declaration.uit
              ? `Atenție: modificarea invalidează codul UIT ${declaration.uit} — după salvare declarația revine în ciornă și trebuie retrimisă la ANAF pentru un cod nou.`
              : 'După salvare, declarația revine în ciornă și poate fi retrimisă la ANAF.'
            : 'Datele se combină din factura/contractul vehiculului, mesajul transportatorului și tabelul logistic intern indexat după VIN.'}
        </p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <select className={field} value={form.vehicleId} onChange={(e) => onVehicleChange(e.target.value)} required>
            <option value="">Selectează vehiculul / VIN-ul…</option>
            {vehicles.map((v: any) => (
              <option key={v.id} value={v.id}>
                {v.make} {v.model} · {v.vin}
              </option>
            ))}
          </select>
          {driveInfo?.matched && (
            <div className="rounded-control border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <p className="font-semibold">Vehicul găsit în tabelul logistic Google Drive</p>
              <p className="mt-0.5">
                MASA: {driveInfo.weightKg ?? '—'} kg · LOCATIE: {driveInfo.unloadingCity || '—'}
              </p>
              {driveInfo.source?.fileName && (
                <p className="mt-0.5 text-emerald-700">
                  {driveInfo.source.fileName} · foaia {driveInfo.source.sheetName} · rândul {driveInfo.rowNumber}
                </p>
              )}
            </div>
          )}
          {driveInfo?.configured && !driveInfo.matched && driveInfo.source?.fileName && (
            <p className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Tabelul {driveInfo.source.fileName} este conectat, dar VIN-ul selectat nu a fost găsit.
            </p>
          )}
          {driveInfo && !driveInfo.configured && (
            <p className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Tabelul logistic Google Drive nu este conectat încă. MASA și LOCATIE pot fi completate manual până la configurare.
            </p>
          )}
          <div className="rounded-control border border-line-strong bg-canvas p-3">
            <label className="text-xs font-semibold text-ink-soft" htmlFor="transport-message">
              Mesaj primit de la transportator (WhatsApp / email)
            </label>
            <p className="mt-1 text-xs text-muted">
              Lipește mesajul complet. Aplicația completează numai datele logistice identificate explicit; factura rămâne sursa pentru vehicul și valoare.
            </p>
            <textarea
              id="transport-message"
              className={`${field} mt-2 min-h-28 resize-y bg-white`}
              value={transportMessage}
              onChange={(event) => {
                setTransportMessage(event.target.value);
                setMessageResult('');
              }}
              maxLength={20_000}
              placeholder={'Exemplu: Transportator..., camion..., remorcă..., încărcare..., data...'}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted">{transportMessage.length.toLocaleString('ro-RO')} / 20.000 caractere</span>
              <button
                type="button"
                disabled={parsingMessage || transportMessage.trim().length < 3}
                onClick={fillFromTransportMessage}
                className="rounded-control bg-sidebar px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                {parsingMessage ? 'Analizez mesajul…' : 'Extrage și completează'}
              </button>
            </div>
            {messageResult && <p className="mt-2 text-xs text-emerald-700">{messageResult}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <select className={field} value={form.operationType} onChange={set('operationType')} required>
              <option value="">Tip operațiune verificat…</option>
              {OPERATION_TYPES.map(([value, label]) => (
                <option key={value} value={value}>{value} — {label}</option>
              ))}
            </select>
            <label className="text-xs font-medium text-muted">
              Data începerii transportului
              <input className={`${field} mt-1`} type="date" value={form.transportDate} onChange={set('transportDate')} required />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <input
              className={field}
              placeholder={loadingTransporterName ? 'Se caută la ANAF…' : 'Transportator'}
              value={form.transporterName}
              onChange={set('transporterName')}
              required
            />
            <input
              className={field}
              placeholder="Cod fiscal transportator"
              value={form.transporterTaxId}
              onChange={set('transporterTaxId')}
              onBlur={() => lookupTransporterName()}
              required
            />
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <input className={field} placeholder="Țară" value={form.transporterCountry} onChange={set('transporterCountry')} maxLength={2} />
            <input className={field} placeholder="Nr. camion" value={form.vehiclePlate} onChange={set('vehiclePlate')} required />
            <input className={field} placeholder="Nr. remorcă" value={form.trailerPlate} onChange={set('trailerPlate')} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <input className={field} placeholder="Loc încărcare (oraș)" value={form.loadingCity} onChange={set('loadingCity')} />
            <input className={field} placeholder="Țară încărcare" value={form.loadingCountry} onChange={set('loadingCountry')} maxLength={2} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <input className={field} placeholder="Loc descărcare (oraș, RO)" value={form.unloadingCity} onChange={set('unloadingCity')} />
            <input className={field} placeholder="Județ descărcare" value={form.unloadingCounty} onChange={set('unloadingCounty')} />
          </div>
          <input className={field} placeholder="Stradă descărcare (RO)" value={form.unloadingAddress} onChange={set('unloadingAddress')} />
          <input className={field} placeholder="Descriere marfă" value={form.goodsDescription} onChange={set('goodsDescription')} required />
          <div className="grid grid-cols-2 gap-2.5">
            <input
              className={field}
              inputMode="numeric"
              pattern="[0-9]{4,10}"
              placeholder="Cod NC/tarifar verificat"
              title="Introduceți codul NC/tarifar din documente (4–10 cifre)"
              value={form.tariffCode}
              onChange={set('tariffCode')}
              required
            />
            <input className={field} type="number" min="0.01" step="0.01" placeholder="Greutate brută reală (kg)" value={form.weightKg} onChange={set('weightKg')} required />
          </div>
          <div className="grid grid-cols-[1fr_110px] gap-2.5">
            <input className={field} type="number" min="0.01" step="0.01" placeholder="Valoare din documentul de achiziție" value={form.valueWithoutVat} onChange={set('valueWithoutVat')} required />
            <input
              className={field}
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase(), exchangeRate: '', exchangeRateDate: '', valueRon: '' })}
              maxLength={3}
              placeholder="Monedă"
              required
            />
          </div>
          {form.currency !== 'RON' && (
            <div className="grid grid-cols-[1fr_auto] gap-2.5">
              <input
                className={field}
                type="number"
                min="0"
                step="0.0001"
                placeholder="Curs BNR (auto din factură; completează manual dacă lipsește)"
                value={form.exchangeRate}
                onChange={(e) =>
                  setForm({
                    ...form,
                    exchangeRate: e.target.value,
                    exchangeRateDate: e.target.value
                      ? form.exchangeRateDate || new Date().toISOString().slice(0, 10)
                      : '',
                  })
                }
              />
              <button
                type="button"
                onClick={applyBnrRate}
                disabled={fetchingRate || !form.currency}
                className="shrink-0 rounded-control border border-line-strong bg-white px-3.5 text-xs font-semibold text-ink-soft disabled:opacity-50"
                title="Preia cursul oficial BNR pentru moneda și data transportului"
              >
                {fetchingRate ? 'Iau cursul…' : 'Curs BNR'}
              </button>
            </div>
          )}
          {currentRonValue != null && Number.isFinite(currentRonValue) && (
            <p className="rounded-control bg-canvas px-3 py-2 text-xs text-muted">
              Valoare declarată: <b className="text-ink">{currentRonValue.toFixed(2)} RON</b>
              {form.currency !== 'RON' && form.exchangeRate && (
                <> · curs BNR {Number(form.exchangeRate).toFixed(6)} din {form.exchangeRateDate}</>
              )}
              {form.currency !== 'RON' && !form.exchangeRate && <> · completează cursul BNR mai sus</>}
            </p>
          )}
          {warnings.length > 0 && (
            <div className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {warnings.map((warning) => <p key={warning}>• {warning}</p>)}
            </div>
          )}
          <label className="flex items-start gap-2.5 rounded-control border border-line-strong p-3 text-xs text-ink-soft">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={form.dataVerified}
              onChange={(e) => setForm({ ...form, dataVerified: e.target.checked })}
              required
            />
            <span>
              Am verificat datele din factură/contract, mesajul transportatorului și tabelul logistic intern: tipul operațiunii, codul NC/tarifar, greutatea reală, traseul, valoarea fără TVA și moneda.
              Pentru valută, cursul se preia din documentul de achiziție (sau îl completezi manual dacă lipsește).
            </span>
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2.5 pt-1">
            <button type="button" onClick={onClose} className="flex-1 rounded-control border border-line-strong py-2.5 text-sm font-semibold text-ink-soft">Anulează</button>
            <button disabled={isLoading} className="flex-1 rounded-control bg-brand py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50">
              {declaration ? 'Salvează → regenerează UIT' : 'Salvează ciorna →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
