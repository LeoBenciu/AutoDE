import { FormEvent, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  useArticlesQuery,
  useCompanyQuery,
  useCreateArticleMutation,
  useCreateManagementMutation,
  useCreatePartyMutation,
  useCreateUserMutation,
  useImportArticlesMutation,
  useImportManagementsMutation,
  useImportPartiesMutation,
  useLazyCompanyFromAnafQuery,
  useManagementsQuery,
  usePartiesQuery,
  useUpdateCompanyMutation,
  useUpdatePartyMutation,
  useUpdateUserMutation,
  useUsersQuery,
} from '../store/api';
import type { ImportResult } from '../store/api';
import { apiUrl } from '../store/apiBase';
import type { RootState } from '../store/store';

const ROLES = ['OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT', 'VIEWER'];
const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Proprietar',
  MANAGER: 'Manager',
  SALES: 'Vânzări',
  ACCOUNTANT: 'Contabil',
  VIEWER: 'Doar citire',
};

export default function Settings() {
  const me = useSelector((state: RootState) => state.auth.user);
  const canManageUsers = ['OWNER', 'MANAGER'].includes(me?.role ?? '');
  const { data: users = [], isLoading: loadingUsers, error: usersError } =
    useUsersQuery(undefined, { skip: !canManageUsers });
  const [updateUser] = useUpdateUserMutation();
  const [message, setMessage] = useState('');
  const isOwner = me?.role === 'OWNER';

  const act = async (fn: () => Promise<any>) => {
    setMessage('');
    try {
      await fn();
    } catch (error: any) {
      setMessage(apiError(error));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink">Setări</h1>
      <p className="mt-1.5 text-sm text-muted">
        Datele firmei, configurarea SAGA și cataloagele folosite la aprobare și export.
      </p>
      {message && (
        <p className="mt-3 rounded-control bg-red-50 px-4 py-2 text-sm text-red-700">
          {message}
        </p>
      )}

      <AccountingSettings onMessage={setMessage} />

      {canManageUsers && (
        <section className="mt-8">
          <div>
            <h2 className="text-lg font-bold text-ink">Utilizatori</h2>
            <p className="mt-1 text-sm text-muted">
              Adaugă colegi, schimbă roluri și dezactivează accesul.
            </p>
          </div>
          {usersError && (
            <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Lista utilizatorilor nu a putut fi încărcată.
            </p>
          )}
          <div className="mt-4 space-y-2">
            {users.map((user: any) => (
              <div
                key={user.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-white p-4"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-ink">
                    {user.name}{' '}
                    {user.id === me?.id && (
                      <span className="text-xs font-normal text-muted-2">(tu)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted">{user.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  {isOwner && user.id !== me?.id ? (
                    <>
                      <select
                        value={user.role}
                        onChange={(event) =>
                          act(() =>
                            updateUser({
                              id: user.id,
                              body: { role: event.target.value },
                            }).unwrap(),
                          )
                        }
                        className={fieldClass}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() =>
                          act(() =>
                            updateUser({
                              id: user.id,
                              body: { active: !user.active },
                            }).unwrap(),
                          )
                        }
                        className={`rounded-control px-3.5 py-2 text-sm font-semibold ${
                          user.active
                            ? 'border border-line-strong text-ink-soft'
                            : 'bg-emerald-600 text-white hover:bg-emerald-700'
                        }`}
                      >
                        {user.active ? 'Dezactivează' : 'Reactivează'}
                      </button>
                    </>
                  ) : (
                    <span className="rounded-full bg-canvas px-2.5 py-0.5 text-xs font-semibold text-ink-soft">
                      {ROLE_LABELS[user.role] ?? user.role}
                    </span>
                  )}
                  {!user.active && (
                    <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700">
                      Dezactivat
                    </span>
                  )}
                </div>
              </div>
            ))}
            {loadingUsers && <p className="text-sm text-muted">Se încarcă…</p>}
          </div>
          {isOwner && <NewUserForm onError={setMessage} />}
        </section>
      )}
    </div>
  );
}

function AccountingSettings({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) {
  const {
    data: company,
    isLoading: loadingCompany,
    error: companyError,
    refetch: refetchCompany,
  } = useCompanyQuery();
  const [updateCompany, { isLoading: savingCompany }] =
    useUpdateCompanyMutation();
  const [loadCompanyFromAnaf, { isFetching: loadingCompanyFromAnaf }] =
    useLazyCompanyFromAnafQuery();
  const [tab, setTab] = useState<'company' | 'partners' | 'articles' | 'managements'>(
    'company',
  );
  const [form, setForm] = useState<Record<string, any>>({});
  const [anafMessage, setAnafMessage] = useState('');

  useEffect(() => {
    if (company) {
      setForm({
        name: company.name ?? '',
        cui: company.cui ?? '',
        registrationNumber: company.registrationNumber ?? '',
        address: company.address ?? '',
        country: company.country ?? 'RO',
        county: company.county ?? '',
        city: company.city ?? '',
        iban: company.iban ?? '',
        bankName: company.bankName ?? '',
        email: company.email ?? '',
        phone: company.phone ?? '',
        defaultCurrency: company.defaultCurrency ?? 'RON',
        isVatPayer: company.isVatPayer ?? true,
        hasTvaLaIncasare: company.hasTvaLaIncasare ?? false,
      });
    }
  }, [company]);

  const saveCompany = async (event: FormEvent) => {
    event.preventDefault();
    onMessage('');
    try {
      await updateCompany(form).unwrap();
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };

  const importCompanyFromAnaf = async () => {
    onMessage('');
    setAnafMessage('');
    const cui = String(form.cui ?? '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/^RO/i, '');

    if (!/^\d{2,10}$/.test(cui)) {
      onMessage(
        'CUI invalid. Folosește între 2 și 10 cifre, opțional cu prefixul RO.',
      );
      return;
    }

    const requestId = createRequestId();
    const endpoint = apiUrl(
      `/accounting/company/anaf/${encodeURIComponent(cui)}`,
    );
    const startedAt = performance.now();
    console.info('[ANAF company import] request started', {
      requestId,
      cui,
      endpoint,
      timestamp: new Date().toISOString(),
    });

    try {
      const details = await loadCompanyFromAnaf({ cui, requestId }).unwrap();
      console.info('[ANAF company import] request succeeded', {
        requestId,
        cui,
        endpoint,
        durationMs: Math.round(performance.now() - startedAt),
        returnedFields: Object.entries(details)
          .filter(([, value]) => value !== null && value !== '')
          .map(([key]) => key),
      });
      setForm((current) => ({
        ...current,
        cui: details.cui ?? cui,
        name: details.name || current.name,
        registrationNumber:
          details.registrationNumber || current.registrationNumber,
        address: details.address || current.address,
        country: details.country || current.country,
        county: details.county || current.county,
        city: details.city || current.city,
        iban: details.iban || current.iban,
        email: details.email || current.email,
        phone: details.phone || current.phone,
        ...(typeof details.isVatPayer === 'boolean'
          ? { isVatPayer: details.isVatPayer }
          : {}),
        ...(typeof details.hasTvaLaIncasare === 'boolean'
          ? { hasTvaLaIncasare: details.hasTvaLaIncasare }
          : {}),
      }));
      setAnafMessage(
        'Datele disponibile au fost preluate din ANAF. Verifică-le, apoi salvează compania.',
      );
    } catch (error: any) {
      console.error('[ANAF company import] request failed', {
        requestId,
        cui,
        endpoint,
        durationMs: Math.round(performance.now() - startedAt),
        status: error?.status,
        originalStatus: error?.originalStatus,
        response: compactErrorData(error?.data),
        errorMessage: error?.error ?? error?.message ?? null,
        rawError: error,
      });
      onMessage(`${apiError(error)} · ID diagnostic: ${requestId}`);
    }
  };

  const tabs = [
    ['company', 'Companie & SAGA'],
    ['partners', 'Parteneri'],
    ['articles', 'Articole'],
    ['managements', 'Gestiuni'],
  ] as const;

  return (
    <section className="mt-5 overflow-hidden rounded-card border border-line bg-white">
      <div className="flex overflow-x-auto border-b border-line">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-semibold ${
              tab === value
                ? 'border-brand text-brand'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'company' && loadingCompany && (
        <p className="p-5 text-sm text-muted">Se încarcă datele companiei…</p>
      )}
      {tab === 'company' && companyError && (
        <div className="m-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-semibold">Datele companiei nu au putut fi încărcate.</p>
          <p className="mt-1">{apiError(companyError)}</p>
          <button
            type="button"
            onClick={() => refetchCompany()}
            className="mt-3 rounded-control border border-red-300 bg-white px-3 py-2 font-semibold hover:bg-red-100"
          >
            Reîncearcă
          </button>
        </div>
      )}
      {tab === 'company' && company && (
        <form onSubmit={saveCompany} className="p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Denumire firmă" value={form.name} onChange={(name) => setForm({ ...form, name })} required />
            <label className="text-xs font-medium text-muted">
              CUI / CIF
              <div className="mt-1 flex gap-2">
                <input
                  aria-label="CUI / CIF"
                  required
                  value={form.cui ?? ''}
                  onChange={(event) => {
                    setForm({ ...form, cui: event.target.value });
                    setAnafMessage('');
                  }}
                  className={`min-w-0 flex-1 ${fieldClass}`}
                />
                <button
                  type="button"
                  onClick={importCompanyFromAnaf}
                  disabled={loadingCompanyFromAnaf}
                  className="shrink-0 rounded-control border border-brand px-3 py-2 text-sm font-semibold text-brand hover:bg-blue-50 disabled:opacity-50"
                >
                  {loadingCompanyFromAnaf ? 'Se caută…' : 'Importă ANAF'}
                </button>
              </div>
            </label>
            <Field label="Nr. registrul comerțului" value={form.registrationNumber} onChange={(registrationNumber) => setForm({ ...form, registrationNumber })} />
            <Field label="Țară" value={form.country} onChange={(country) => setForm({ ...form, country })} />
            <Field label="Județ" value={form.county} onChange={(county) => setForm({ ...form, county })} />
            <Field label="Localitate" value={form.city} onChange={(city) => setForm({ ...form, city })} />
            <Field label="Adresă" value={form.address} onChange={(address) => setForm({ ...form, address })} className="sm:col-span-2" />
            <Field label="IBAN" value={form.iban} onChange={(iban) => setForm({ ...form, iban })} />
            <Field label="Bancă" value={form.bankName} onChange={(bankName) => setForm({ ...form, bankName })} />
            <Field label="Email" value={form.email} onChange={(email) => setForm({ ...form, email })} type="email" />
            <Field label="Telefon" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
            <Field label="Monedă implicită" value={form.defaultCurrency} onChange={(defaultCurrency) => setForm({ ...form, defaultCurrency })} />
          </div>
          {anafMessage && (
            <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {anafMessage}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-5">
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(form.isVatPayer)}
                onChange={(event) => setForm({ ...form, isVatPayer: event.target.checked })}
              />
              Firmă plătitoare de TVA
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(form.hasTvaLaIncasare)}
                onChange={(event) => setForm({ ...form, hasTvaLaIncasare: event.target.checked })}
              />
              TVA la încasare
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-xs text-muted">
              Data activării contabilității: {company?.accountingCutoverAt ? new Date(company.accountingCutoverAt).toLocaleString('ro-RO') : '—'}.
              Documentele anterioare rămân istorice.
            </p>
            <button
              disabled={savingCompany}
              className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {savingCompany ? 'Se salvează…' : 'Salvează compania'}
            </button>
          </div>
        </form>
      )}
      {tab === 'partners' && <PartnersCatalogue onMessage={onMessage} />}
      {tab === 'articles' && <ArticlesCatalogue onMessage={onMessage} />}
      {tab === 'managements' && <ManagementsCatalogue onMessage={onMessage} />}
    </section>
  );
}

function PartnersCatalogue({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) {
  const { data: parties = [] } = usePartiesQuery();
  const [createParty, { isLoading }] = useCreatePartyMutation();
  const [updateParty] = useUpdatePartyMutation();
  const [importParties] = useImportPartiesMutation();
  const empty = {
    kind: 'COMPANY',
    name: '',
    taxId: '',
    isSupplier: true,
    isClient: false,
    supplierAnalytic: '',
    clientAnalytic: '',
  };
  const [form, setForm] = useState(empty);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await createParty({ ...form, country: 'RO' }).unwrap();
      setForm(empty);
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };
  return (
    <div className="p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <CsvImport
          label="Importă furnizori (CSV)"
          hint="Coloane: cod, denumire, cui/cnp, tip, analitic, adresa, iban…"
          onImport={(file) => importParties({ file, role: 'supplier' }).unwrap()}
          onMessage={onMessage}
        />
        <CsvImport
          label="Importă clienți (CSV)"
          hint="Coloane: cod, denumire, cui, analitic, adresa, iban…"
          onImport={(file) => importParties({ file, role: 'client' }).unwrap()}
          onMessage={onMessage}
        />
      </div>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <select
          aria-label="Tip partener"
          className={fieldClass}
          value={form.kind}
          onChange={(event) => setForm({ ...form, kind: event.target.value })}
        >
          <option value="COMPANY">Companie</option>
          <option value="INDIVIDUAL">Persoană fizică</option>
        </select>
        <input className={fieldClass} placeholder="Denumire partener" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input
          aria-label={form.kind === 'INDIVIDUAL' ? 'CNP' : 'CUI / CIF'}
          className={fieldClass}
          placeholder={form.kind === 'INDIVIDUAL' ? 'CNP' : 'CUI / CIF'}
          value={form.taxId}
          onChange={(event) => setForm({ ...form, taxId: event.target.value })}
        />
        <input className={fieldClass} placeholder="Analitic furnizor (401.x)" value={form.supplierAnalytic} onChange={(event) => setForm({ ...form, supplierAnalytic: event.target.value })} />
        <input className={fieldClass} placeholder="Analitic client (411.x)" value={form.clientAnalytic} onChange={(event) => setForm({ ...form, clientAnalytic: event.target.value })} />
        <div className="flex items-center gap-4 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={form.isSupplier} onChange={(event) => setForm({ ...form, isSupplier: event.target.checked })} /> Furnizor
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={form.isClient} onChange={(event) => setForm({ ...form, isClient: event.target.checked })} /> Client
          </label>
        </div>
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Adaugă partener
        </button>
      </form>
      <div className="mt-4 divide-y divide-line rounded-xl border border-line">
        {parties.map((party: any) => (
          <PartyRow
            key={party.id}
            party={party}
            onSave={(body) => updateParty({ id: party.id, body }).unwrap()}
          />
        ))}
        {parties.length === 0 && <p className="p-4 text-sm text-muted">Catalogul este gol.</p>}
      </div>
    </div>
  );
}

function PartyRow({
  party,
  onSave,
}: {
  party: any;
  onSave: (body: any) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState({
    kind: party.kind ?? 'COMPANY',
    isSupplier: party.isSupplier,
    isClient: party.isClient,
    supplierAnalytic: party.supplierAnalytic ?? '',
    clientAnalytic: party.clientAnalytic ?? '',
  });
  const [saving, setSaving] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-44 flex-1">
        <p className="text-sm font-semibold text-ink">{party.name}</p>
        <p className="text-xs text-muted">
          {party.kind === 'INDIVIDUAL' ? 'Persoană fizică' : 'Companie'} · {party.taxId || (party.kind === 'INDIVIDUAL' ? 'Fără CNP' : 'Fără CUI')}
        </p>
      </div>
      <select
        aria-label={`Tip partener ${party.name}`}
        className={`${fieldClass} w-36`}
        value={draft.kind}
        onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
      >
        <option value="COMPANY">Companie</option>
        <option value="INDIVIDUAL">Persoană fizică</option>
      </select>
      <label className="flex items-center gap-1 text-xs text-muted">
        <input type="checkbox" checked={draft.isSupplier} onChange={(event) => setDraft({ ...draft, isSupplier: event.target.checked })} /> Furnizor
      </label>
      <label className="flex items-center gap-1 text-xs text-muted">
        <input type="checkbox" checked={draft.isClient} onChange={(event) => setDraft({ ...draft, isClient: event.target.checked })} /> Client
      </label>
      <input className={`${fieldClass} w-32`} placeholder="401.x" value={draft.supplierAnalytic} onChange={(event) => setDraft({ ...draft, supplierAnalytic: event.target.value })} />
      <input className={`${fieldClass} w-32`} placeholder="411.x" value={draft.clientAnalytic} onChange={(event) => setDraft({ ...draft, clientAnalytic: event.target.value })} />
      <button
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(draft);
          } finally {
            setSaving(false);
          }
        }}
        className="rounded-control border border-line-strong px-3 py-2 text-xs font-semibold text-ink-soft disabled:opacity-50"
        disabled={saving}
      >
        {saving ? 'Se salvează…' : 'Salvează'}
      </button>
    </div>
  );
}

function ArticlesCatalogue({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) {
  const { data: articles = [] } = useArticlesQuery();
  const [create, { isLoading }] = useCreateArticleMutation();
  const [importArticles] = useImportArticlesMutation();
  const empty = {
    code: '',
    name: '',
    analyticCode: '',
    vatRate: 'TWENTYONE',
    unit: 'BUCATA',
    type: 'MARFURI',
    accountCode: '371',
  };
  const [form, setForm] = useState(empty);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await create(form).unwrap();
      setForm(empty);
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };
  return (
    <div className="p-5">
      <CsvImport
        label="Importă articole (CSV)"
        hint="Coloane: cod, denumire, um, tva, den_tip, analitic, cont"
        onImport={(file) => importArticles(file).unwrap()}
        onMessage={onMessage}
      />
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input className={fieldClass} placeholder="Cod intern" required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        <input className={fieldClass} placeholder="Denumire" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input className={fieldClass} placeholder="Cod analitic SAGA" value={form.analyticCode} onChange={(event) => setForm({ ...form, analyticCode: event.target.value })} />
        <input className={fieldClass} placeholder="Cont" value={form.accountCode} onChange={(event) => setForm({ ...form, accountCode: event.target.value })} />
        <select className={fieldClass} value={form.vatRate} onChange={(event) => setForm({ ...form, vatRate: event.target.value })}>
          {['ZERO', 'FIVE', 'NINE', 'ELEVEN', 'NINETEEN', 'TWENTYONE'].map((value) => <option key={value} value={value}>TVA {value}</option>)}
        </select>
        <input className={fieldClass} placeholder="UM" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} />
        <input className={fieldClass} placeholder="Tip SAGA" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} />
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Adaugă articol</button>
      </form>
      <CatalogueTable
        columns={['Cod', 'Denumire', 'Analitic SAGA', 'TVA', 'UM', 'Cont']}
        rows={articles.map((article: any) => [
          article.code,
          article.name,
          article.analyticCode || '—',
          article.vatRate,
          article.unit,
          article.accountCode || '—',
        ])}
      />
    </div>
  );
}

function ManagementsCatalogue({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) {
  const { data: managements = [] } = useManagementsQuery();
  const [create, { isLoading }] = useCreateManagementMutation();
  const [importManagements] = useImportManagementsMutation();
  const [form, setForm] = useState({
    code: '',
    name: '',
    analyticCode: '',
    type: 'CANTITATIV_VALORICA',
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await create(form).unwrap();
      setForm({ code: '', name: '', analyticCode: '', type: 'CANTITATIV_VALORICA' });
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };
  return (
    <div className="p-5">
      <CsvImport
        label="Importă gestiuni (CSV)"
        hint="Coloane: cod, denumire, tip_gestiune, analitic"
        onImport={(file) => importManagements(file).unwrap()}
        onMessage={onMessage}
      />
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input className={fieldClass} placeholder="Cod gestiune" required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        <input className={fieldClass} placeholder="Denumire" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input className={fieldClass} placeholder="Cod analitic" value={form.analyticCode} onChange={(event) => setForm({ ...form, analyticCode: event.target.value })} />
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Adaugă gestiune</button>
      </form>
      <CatalogueTable
        columns={['Cod', 'Denumire', 'Tip', 'Analitic']}
        rows={managements.map((management: any) => [
          management.code,
          management.name,
          management.type,
          management.analyticCode || '—',
        ])}
      />
    </div>
  );
}

function CsvImport({
  label,
  hint,
  onImport,
  onMessage,
}: {
  label: string;
  hint: string;
  onImport: (file: File) => Promise<ImportResult>;
  onMessage: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handle = async (file?: File | null) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    onMessage('');
    try {
      setResult(await onImport(file));
    } catch (error: any) {
      onMessage(apiError(error));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-dashed border-line-strong bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => handle(event.target.files?.[0])}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="rounded-control border border-line-strong px-3 py-2 text-sm font-semibold text-ink-soft disabled:opacity-50"
        >
          {busy ? 'Se importă…' : label}
        </button>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      {result && (
        <p className="mt-2 text-xs text-emerald-700">
          Import finalizat: {result.created} adăugate, {result.updated} actualizate din {result.total} rânduri.
          {result.errors.length > 0 && ` ${result.errors.length} rânduri ignorate.`}
        </p>
      )}
      {result && result.errors.length > 0 && (
        <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-5 text-xs text-amber-700">
          {result.errors.slice(0, 10).map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CatalogueTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: string[][];
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-muted">
          <tr>{columns.map((column) => <th key={column} className="px-3 py-2 font-semibold">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-line">
              {row.map((value, cell) => <td key={cell} className="px-3 py-2 text-ink-soft">{value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="p-4 text-sm text-muted">Catalogul este gol.</p>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  type = 'text',
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  className?: string;
}) {
  return (
    <label className={`text-xs font-medium text-muted ${className}`}>
      {label}
      <input
        type={type}
        required={required}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 block w-full ${fieldClass}`}
      />
    </label>
  );
}

function NewUserForm({ onError }: { onError: (message: string) => void }) {
  const [createUser, { isLoading }] = useCreateUserMutation();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'SALES',
  });
  const [ok, setOk] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onError('');
    setOk('');
    try {
      await createUser(form).unwrap();
      setOk(`Cont creat pentru ${form.email}.`);
      setForm({ name: '', email: '', password: '', role: 'SALES' });
    } catch (error: any) {
      onError(apiError(error));
    }
  };

  return (
    <form onSubmit={submit} className="mt-4 rounded-card border border-line bg-white p-4">
      <h3 className="font-semibold text-ink">Adaugă utilizator</h3>
      <div className="mt-3 flex flex-wrap gap-2.5">
        <input className={fieldClass} placeholder="Nume" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
        <input className={fieldClass} type="email" placeholder="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
        <input className={fieldClass} type="password" placeholder="Parolă (min. 8)" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required minLength={8} />
        <select className={fieldClass} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
          {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
        </select>
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
          Creează cont
        </button>
      </div>
      {ok && <p className="mt-2 text-sm text-emerald-700">{ok}</p>}
    </form>
  );
}

const fieldClass =
  'rounded-control border border-line-strong px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none';

function apiError(error: any): string {
  const body = error?.data;
  if (Array.isArray(body?.message)) return body.message.join(' · ');
  if (body?.message) return body.message;
  if (error?.status === 401) {
    return 'Sesiunea a expirat. Deconectează-te și autentifică-te din nou.';
  }
  if (error?.status === 'FETCH_ERROR') {
    return 'Backend-ul nu poate fi contactat. Verifică dacă serviciul API este pornit și publicat.';
  }
  if (error?.status === 'PARSING_ERROR') {
    const status = error?.originalStatus;
    if (typeof body === 'string' && /<!doctype html|<html[\s>]/i.test(body)) {
      return `Serverul frontend a returnat aplicația HTML pentru o cerere API${
        status ? ` (HTTP ${status})` : ''
      }. Configurează VITE_API_URL către backend și reconstruiește frontendul.`;
    }
    return status === 404
      ? 'Endpoint-ul solicitat nu există pe versiunea de backend publicată (HTTP 404).'
      : `Serverul a returnat un răspuns nevalid${status ? ` (HTTP ${status})` : ''}.`;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 240);
  return (
    error?.error ??
    error?.message ??
    `Acțiunea nu a putut fi finalizată${
      typeof error?.status === 'number' ? ` (HTTP ${error.status})` : ''
    }`
  );
}

function createRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `anaf-${uuid}`
    : `anaf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function compactErrorData(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}
