import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  useSagaPreferencesQuery,
  useSagaPreviewMutation,
  useSaveSagaPreferencesMutation,
} from '../store/api';
import { apiUrl } from '../store/apiBase';
import type { RootState } from '../store/store';

const EXPORT_TYPES = [
  ['facturi', 'Facturi', 'Facturi aprobate și bonuri/chitanțe independente'],
  ['incasari', 'Încasări', 'Debit pe 5311, 5121 sau 5124 din documente aprobate'],
  ['plati', 'Plăți', 'Credit pe 5311, 5121 sau 5124 din documente aprobate'],
  ['furnizori', 'Furnizori', 'Catalogul partenerilor marcați ca furnizori'],
  ['clienti', 'Clienți', 'Catalogul partenerilor marcați ca clienți'],
  ['articole', 'Articole', 'Catalogul articolelor cu analitic SAGA'],
] as const;

type ExportType = (typeof EXPORT_TYPES)[number][0];

interface ExportConfig {
  types: ExportType[];
  from: string;
  to: string;
  preset: string;
}

export default function Exports() {
  const token = useSelector((state: RootState) => state.auth.accessToken);
  const defaults = useMemo(() => configForPreset('month'), []);
  const [config, setConfig] = useState<ExportConfig>(defaults);
  const [step, setStep] = useState(1);
  const [preview, { isLoading: previewing }] = useSagaPreviewMutation();
  const { data: savedPreferences, isSuccess: preferencesLoaded } =
    useSagaPreferencesQuery();
  const [savePreferences] = useSaveSagaPreferencesMutation();
  const preferencesApplied = useRef(false);
  const [result, setResult] = useState<any>();
  const [message, setMessage] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setResult(undefined);
  }, [config]);

  useEffect(() => {
    if (!preferencesLoaded || preferencesApplied.current) return;
    preferencesApplied.current = true;
    if (savedPreferences) {
      setConfig(normalizeConfig(savedPreferences, defaults));
    }
  }, [defaults, preferencesLoaded, savedPreferences]);

  const goToPreview = async () => {
    setMessage('');
    try {
      const response = await preview(config).unwrap();
      await savePreferences(config).unwrap();
      setResult(response);
      setStep(3);
    } catch (error: any) {
      setMessage(apiError(error));
    }
  };

  const download = async (
    exportConfig: ExportConfig = config,
    quick = false,
  ) => {
    setExporting(true);
    setMessage('');
    try {
      const response = await fetch(apiUrl('/saga/export'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(exportConfig),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(
          Array.isArray(body?.errors)
            ? body.errors.join(' · ')
            : body?.message ?? `Export eșuat (${response.status})`,
        );
      }
      const blob = await response.blob();
      const name =
        response.headers
          .get('Content-Disposition')
          ?.match(/filename="([^"]+)"/)?.[1] ?? 'SAGA_Export.zip';
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
      await savePreferences(exportConfig).unwrap();
      setConfig(exportConfig);
      setMessage(
        quick
          ? `${name} a fost re-generat folosind ultima configurație.`
          : `${name} a fost generat cu succes.`,
      );
    } catch (error: any) {
      setMessage(error?.message ?? 'Exportul nu a putut fi generat');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">Exporturi SAGA</h1>
            <p className="mt-1.5 text-sm text-muted">
              Generează un singur ZIP din documentele aprobate, notele contabile și cataloagele firmei.
            </p>
          </div>
          {savedPreferences && (
            <button
              onClick={() =>
                download(normalizeConfig(savedPreferences, defaults), true)
              }
              disabled={exporting}
              className="rounded-control border border-brand bg-blue-50 px-4 py-2.5 text-sm font-semibold text-brand hover:bg-blue-100 disabled:opacity-50"
            >
              {exporting ? 'Se generează…' : 'Re-exportă ultima configurație'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-2">
        {[
          [1, 'Date exportate'],
          [2, 'Perioadă'],
          [3, 'Verificare'],
        ].map(([number, label]) => (
          <button
            key={number}
            onClick={() => Number(number) < step && setStep(Number(number))}
            className={`rounded-xl border px-3 py-3 text-left text-sm ${
              step === number
                ? 'border-brand bg-blue-50 text-brand'
                : Number(number) < step
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-line bg-white text-muted'
            }`}
          >
            <span className="mr-2 font-bold">{number}.</span>{label}
          </button>
        ))}
      </div>

      {message && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            message.includes('succes')
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {message}
        </div>
      )}

      {step === 1 && (
        <section className="mt-4 rounded-card border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Ce vrei să incluzi?</h2>
          <p className="mt-1 text-xs text-muted">
            Fișierele fără înregistrări vor fi omise automat din arhivă, la fel ca în Finova.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {EXPORT_TYPES.map(([type, label, description]) => {
              const selected = config.types.includes(type);
              return (
                <label
                  key={type}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-3.5 ${
                    selected ? 'border-brand bg-blue-50/50' : 'border-line hover:border-line-strong'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() =>
                      setConfig((current) => ({
                        ...current,
                        types: selected
                          ? current.types.filter((item) => item !== type)
                          : [...current.types, type],
                      }))
                    }
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink">{label}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted">{description}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <WizardFooter
            nextLabel="Continuă la perioadă"
            nextDisabled={config.types.length === 0}
            onNext={() => setStep(2)}
          />
        </section>
      )}

      {step === 2 && (
        <section className="mt-4 rounded-card border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Alege perioada</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              ['month', 'Luna curentă'],
              ['quarter', 'Trimestrul curent'],
              ['year', 'Anul curent'],
              ['custom', 'Interval personalizat'],
            ].map(([preset, label]) => (
              <button
                key={preset}
                onClick={() =>
                  setConfig((current) => ({
                    ...current,
                    ...configForPreset(preset, current.types),
                  }))
                }
                className={`rounded-control border px-3 py-2 text-sm font-semibold ${
                  config.preset === preset
                    ? 'border-brand bg-blue-50 text-brand'
                    : 'border-line-strong text-ink-soft'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <DateField
              label="De la"
              value={config.from}
              onChange={(from) => setConfig((current) => ({ ...current, from, preset: 'custom' }))}
            />
            <DateField
              label="Până la"
              value={config.to}
              onChange={(to) => setConfig((current) => ({ ...current, to, preset: 'custom' }))}
            />
          </div>
          <WizardFooter
            back
            nextLabel={previewing ? 'Se verifică…' : 'Verifică exportul'}
            nextDisabled={previewing || !config.from || !config.to || config.from > config.to}
            onBack={() => setStep(1)}
            onNext={goToPreview}
          />
        </section>
      )}

      {step === 3 && result && (
        <section className="mt-4 rounded-card border border-line bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-ink">Previzualizare export</h2>
              <p className="mt-1 text-xs text-muted">
                {formatDate(result.from)} – {formatDate(result.to)}
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${
              result.canExport ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
            }`}>
              {result.canExport ? 'Pregătit pentru export' : 'Necesită corectare'}
            </span>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {result.files.map((file: any) => (
              <div
                key={file.type}
                className={`rounded-xl border p-3 ${
                  file.included ? 'border-line bg-white' : 'border-dashed border-line bg-slate-50'
                }`}
              >
                <p className="text-xs uppercase tracking-wide text-muted">{typeLabel(file.type)}</p>
                <p className="mt-1 text-2xl font-bold text-ink">{file.rows}</p>
                <p className="mt-1 text-[11px] text-muted">
                  {file.included ? 'înregistrări în XML' : 'XML omis din ZIP'}
                </p>
              </div>
            ))}
          </div>

          {(result.blockingErrors?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              <p className="mb-1 font-bold">Erori care blochează exportul</p>
              {result.blockingErrors.map((error: string) => <p key={error}>• {error}</p>)}
            </div>
          )}

          <details className="mt-4 rounded-xl border border-line">
            <summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-ink">
              Documente excluse ({result.excludedCount})
            </summary>
            <div className="max-h-60 overflow-y-auto border-t border-line">
              {(result.excluded ?? []).map((document: any) => (
                <div key={document.id} className="flex justify-between gap-3 border-b border-line px-3 py-2 text-xs last:border-0">
                  <span className="truncate font-medium text-ink">{document.name}</span>
                  <span className="shrink-0 text-right text-muted">{document.reason}</span>
                </div>
              ))}
              {result.excludedCount === 0 && <p className="p-3 text-xs text-muted">Niciun document exclus.</p>}
            </div>
          </details>

          <WizardFooter
            back
            nextLabel={exporting ? 'Se generează ZIP…' : 'Descarcă exportul ZIP'}
            nextDisabled={exporting || !result.canExport}
            onBack={() => setStep(2)}
            onNext={() => download()}
          />
        </section>
      )}
    </div>
  );
}

function normalizeConfig(value: any, fallback: ExportConfig): ExportConfig {
  const types = Array.isArray(value?.types)
    ? value.types.filter((type: unknown): type is ExportType =>
        EXPORT_TYPES.some(([candidate]) => candidate === type),
      )
    : fallback.types;
  return {
    types: types.length > 0 ? types : fallback.types,
    from: typeof value?.from === 'string' ? value.from : fallback.from,
    to: typeof value?.to === 'string' ? value.to : fallback.to,
    preset: typeof value?.preset === 'string' ? value.preset : 'custom',
  };
}

function WizardFooter({
  back,
  nextLabel,
  nextDisabled,
  onBack,
  onNext,
}: {
  back?: boolean;
  nextLabel: string;
  nextDisabled?: boolean;
  onBack?: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mt-6 flex justify-between border-t border-line pt-4">
      {back ? (
        <button onClick={onBack} className="rounded-control border border-line-strong px-4 py-2.5 text-sm font-semibold text-ink-soft">
          Înapoi
        </button>
      ) : <span />}
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {nextLabel}
      </button>
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-medium text-muted">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block rounded-control border border-line-strong px-3 py-2.5 text-sm text-ink focus:border-brand focus:outline-none"
      />
    </label>
  );
}

function configForPreset(
  preset: string,
  types: ExportType[] = EXPORT_TYPES.map(([type]) => type),
): ExportConfig {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = localIso(now);
  let from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  let to = today;
  if (preset === 'quarter') {
    const firstMonth = Math.floor(month / 3) * 3;
    from = localIso(new Date(year, firstMonth, 1));
    to = localIso(new Date(year, firstMonth + 3, 0));
  }
  if (preset === 'year') {
    from = `${year}-01-01`;
    to = `${year}-12-31`;
  }
  return { types, from, to, preset };
}

function localIso(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function typeLabel(type: string): string {
  return EXPORT_TYPES.find(([value]) => value === type)?.[1] ?? type;
}

function formatDate(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString('ro-RO');
}

function apiError(error: any): string {
  const body = error?.data;
  if (Array.isArray(body?.errors)) return body.errors.join(' · ');
  if (Array.isArray(body?.message)) return body.message.join(' · ');
  return body?.message ?? error?.message ?? 'Previzualizarea nu a putut fi generată';
}
